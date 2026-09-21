from pathlib import Path
import hashlib
import re
import sys
from typing import Dict, List, Tuple

import chromadb
import frontmatter
import requests

# Mesma razão do search_knowledge.py: nomes/headings com caractere fora do
# cp1252 do console Windows derrubariam o `print()` de progresso no meio da
# indexação.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


KNOWLEDGE_DIR = Path(r"C:\App Whats\Info_Bots")
CHROMA_DIR = Path(r"C:\App Whats\rag\chroma_db")

OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings"
EMBED_MODEL = "nomic-embed-text"

COLLECTION_NAME = "mibro_knowledge"

TARGET_CHUNK_SIZE = 800
MAX_CHUNK_SIZE = 1100
MIN_CHUNK_SIZE = 180
CHUNK_OVERLAP = 100


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_markdown_sections(text: str) -> List[Tuple[str, str]]:
    """
    Divide Markdown em seções preservando o heading atual.
    """
    lines = text.splitlines()

    sections: List[Tuple[str, str]] = []

    current_heading = ""
    current_lines: List[str] = []

    for line in lines:
        if re.match(r"^#{1,6}\s+", line):
            if current_lines:
                content = clean_text("\n".join(current_lines))

                if content:
                    sections.append((current_heading, content))

            current_heading = re.sub(r"^#{1,6}\s+", "", line).strip()
            current_lines = [line]
        else:
            current_lines.append(line)

    if current_lines:
        content = clean_text("\n".join(current_lines))

        if content:
            sections.append((current_heading, content))

    return sections


def split_large_text(text: str) -> List[str]:
    """
    Quebra seções grandes tentando respeitar parágrafos.
    """
    if len(text) <= MAX_CHUNK_SIZE:
        return [text]

    paragraphs = [
        p.strip()
        for p in re.split(r"\n\s*\n", text)
        if p.strip()
    ]

    chunks: List[str] = []
    current = ""

    for paragraph in paragraphs:
        if not current:
            current = paragraph
            continue

        candidate = f"{current}\n\n{paragraph}"

        if len(candidate) <= TARGET_CHUNK_SIZE:
            current = candidate
            continue

        chunks.append(current.strip())

        overlap = current[-CHUNK_OVERLAP:].strip()

        if overlap:
            current = f"{overlap}\n\n{paragraph}"
        else:
            current = paragraph

        while len(current) > MAX_CHUNK_SIZE:
            cut = current.rfind(". ", 0, MAX_CHUNK_SIZE)

            if cut < MIN_CHUNK_SIZE:
                cut = current.rfind(" ", 0, MAX_CHUNK_SIZE)

            if cut < MIN_CHUNK_SIZE:
                cut = MAX_CHUNK_SIZE

            part = current[:cut].strip()

            if part:
                chunks.append(part)

            overlap = part[-CHUNK_OVERLAP:].strip()

            current = (
                f"{overlap} {current[cut:].strip()}"
                if overlap
                else current[cut:].strip()
            )

    if current.strip():
        chunks.append(current.strip())

    return chunks


def build_chunks(text: str) -> List[Tuple[str, str]]:
    """
    Retorna lista de:
    (heading, chunk)
    """
    result: List[Tuple[str, str]] = []

    for heading, section in split_markdown_sections(text):
        pieces = split_large_text(section)

        for piece in pieces:
            if len(piece.strip()) >= MIN_CHUNK_SIZE:
                result.append((heading, piece.strip()))

    return result


def get_embedding(text: str) -> List[float]:
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": EMBED_MODEL,
            "prompt": text,
        },
        timeout=120,
    )

    response.raise_for_status()

    data = response.json()

    embedding = data.get("embedding")

    if not embedding:
        raise RuntimeError(
            "Ollama não retornou embedding."
        )

    return embedding


def normalize_metadata_value(value):
    if value is None:
        return ""

    if isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, list):
        return ", ".join(str(item) for item in value)

    return str(value)


# Mapeamento mínimo nome de arquivo -> produto, usado só quando o front
# matter não declara `product` (arquivos gerais de Suporte/Garantia/Atacado/
# etc. continuam sem produto, de propósito — isso é o comportamento certo,
# não um bug). Ordenado do mais específico para o mais genérico (GS Pro 2
# antes de GS Pro, Lite 3 Pro antes de Lite 3, GS Explorer S antes de GS
# Explorer) para nunca casar o nome errado por sub-string do stem.
FILENAME_PRODUCT_MAP: List[Tuple[str, str]] = sorted(
    [
        ("mibro-c4", "C4"),
        ("mibro-a3", "A3"),
        ("mibro-lite-3-pro", "Lite 3 Pro"),
        ("mibro-lite-3", "Lite 3"),
        ("mibro-gs-pro-2", "GS Pro 2"),
        ("mibro-gs-pro", "GS Pro"),
        ("mibro-gs-active-2", "GS Active2"),
        ("mibro-gs-active", "GS Active"),
        ("mibro-fit", "Mibro FIT"),
        ("mibro-gt", "Mibro GT"),
        ("mibro-gs-explorer-s", "GS Explorer S"),
        ("mibro-gs-explorer", "GS Explorer"),
        ("mibro-earbuds-open-ear-pro", "Earbuds Open Ear Pro"),
        ("mibro-earbuds-open-ear", "Earbuds Open Ear"),
        ("mibro-earbuds-5", "Earbuds 5"),
    ],
    key=lambda pair: len(pair[0]),
    reverse=True,
)

# Nomes que ficariam ambíguos demais sem a marca (um "FIT"/"GT" solto não diz
# nada) — mantidos com o prefixo "Mibro ", exatamente como
# search_knowledge.py já espera em KNOWN_PRODUCTS.
_AMBIGUOUS_BARE_PRODUCT_NAMES = {"fit", "gt"}
_MIBRO_PREFIX_RE = re.compile(r"^mibro\s+(.+)$", re.IGNORECASE)


def normalize_product_name(raw: str) -> str:
    """
    Canoniza o nome do produto para o MESMO formato usado por
    search_knowledge.py (KNOWN_PRODUCTS/detect_product) — sem isso, um
    front matter com `product: Mibro GS Pro 2` nunca bate com o filtro
    detectado a partir de "GS Pro 2" na busca (a causa raiz do bug relatado:
    a busca detecta o produto certo, mas o filtro não encontra nada porque
    o valor indexado tinha o prefixo "Mibro " e o detectado não).
    """
    value = (raw or "").strip()

    if not value:
        return ""

    match = _MIBRO_PREFIX_RE.match(value)

    if not match:
        return value

    rest = match.group(1).strip()

    if rest.lower() in _AMBIGUOUS_BARE_PRODUCT_NAMES:
        return value

    return rest


def infer_product_from_filename(file_path: Path) -> str:
    stem = file_path.stem.lower()

    for filename_key, product in FILENAME_PRODUCT_MAP:
        if stem.startswith(filename_key):
            return product

    return ""


def resolve_product(file_path: Path, frontmatter_product) -> str:
    """
    Front matter sempre vence quando presente (item "preservar o valor
    existente") — só normalizado para o formato canônico. Sem `product` no
    front matter, tenta inferir pelo nome do arquivo; sem match nenhum,
    fica vazio (arquivo geral, sem produto específico — nunca forçado).
    """
    existing = normalize_metadata_value(frontmatter_product)

    if existing:
        return normalize_product_name(str(existing))

    return infer_product_from_filename(file_path)


def infer_path_metadata(relative_path: Path) -> Dict:
    parts = relative_path.parts

    folder = parts[0] if parts else ""

    category = ""

    if len(parts) >= 2:
        category = parts[1]

    return {
        "folder": folder,
        "category": category,
    }


def deterministic_chunk_id(
    relative_path: str,
    chunk_index: int,
) -> str:
    raw = f"{relative_path}::{chunk_index}"

    digest = hashlib.sha256(
        raw.encode("utf-8")
    ).hexdigest()[:24]

    return f"chunk_{digest}"


def main():
    if not KNOWLEDGE_DIR.exists():
        print(
            f"ERRO: pasta não encontrada: {KNOWLEDGE_DIR}"
        )
        sys.exit(1)

    CHROMA_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    client = chromadb.PersistentClient(
        path=str(CHROMA_DIR)
    )

    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={
            "description": (
                "Knowledge Base Mibro Brasil"
            )
        },
    )

    md_files = sorted(
        KNOWLEDGE_DIR.rglob("*.md")
    )

    print(
        f"Arquivos encontrados: {len(md_files)}"
    )
    print()

    total_chunks = 0
    processed_files = 0
    errors = []

    for file_path in md_files:
        relative_path = file_path.relative_to(
            KNOWLEDGE_DIR
        )

        print(
            f"Indexando: {relative_path}"
        )

        try:
            post = frontmatter.load(
                str(file_path)
            )

            content = clean_text(
                post.content
            )

            chunks = build_chunks(
                content
            )

            if not chunks:
                print(
                    "  Aviso: nenhum chunk válido."
                )
                continue

            path_metadata = infer_path_metadata(
                relative_path
            )

            base_metadata = {
                "source_file": file_path.name,
                "relative_path": str(
                    relative_path
                ),
                "folder": path_metadata.get(
                    "folder",
                    "",
                ),
                "category": (
                    normalize_metadata_value(
                        post.metadata.get(
                            "category",
                            path_metadata.get(
                                "category",
                                "",
                            ),
                        )
                    )
                ),
                "type": normalize_metadata_value(
                    post.metadata.get(
                        "type"
                    )
                ),
                "topic": normalize_metadata_value(
                    post.metadata.get(
                        "topic"
                    )
                ),
                "brand": normalize_metadata_value(
                    post.metadata.get(
                        "brand"
                    )
                ),
                "product": resolve_product(
                    file_path,
                    post.metadata.get("product"),
                ),
                "source": normalize_metadata_value(
                    post.metadata.get(
                        "source"
                    )
                ),
                "updated": normalize_metadata_value(
                    post.metadata.get(
                        "updated"
                    )
                ),
                "status": normalize_metadata_value(
                    post.metadata.get(
                        "status"
                    )
                ),
                "confidence": normalize_metadata_value(
                    post.metadata.get(
                        "confidence"
                    )
                ),
            }

            existing = collection.get(
                where={
                    "relative_path": str(
                        relative_path
                    )
                }
            )

            existing_ids = (
                existing.get(
                    "ids",
                    [],
                )
                if existing
                else []
            )

            if existing_ids:
                collection.delete(
                    ids=existing_ids
                )

            ids = []
            documents = []
            embeddings = []
            metadatas = []

            for index, (
                heading,
                chunk,
            ) in enumerate(chunks):
                chunk_id = deterministic_chunk_id(
                    str(relative_path),
                    index,
                )

                metadata = dict(
                    base_metadata
                )

                metadata["heading"] = heading
                metadata["chunk_index"] = index

                embedding = get_embedding(
                    chunk
                )

                ids.append(
                    chunk_id
                )
                documents.append(
                    chunk
                )
                embeddings.append(
                    embedding
                )
                metadatas.append(
                    metadata
                )

            collection.add(
                ids=ids,
                documents=documents,
                embeddings=embeddings,
                metadatas=metadatas,
            )

            processed_files += 1
            total_chunks += len(
                chunks
            )

            print(
                f"  OK: {len(chunks)} chunks"
            )

        except Exception as exc:
            errors.append(
                (
                    str(relative_path),
                    str(exc),
                )
            )

            print(
                f"  ERRO: {exc}"
            )

    print()
    print("=" * 60)
    print("INDEXAÇÃO FINALIZADA")
    print("=" * 60)
    print(
        f"Arquivos encontrados: {len(md_files)}"
    )
    print(
        f"Arquivos processados: {processed_files}"
    )
    print(
        f"Chunks indexados: {total_chunks}"
    )
    print(
        f"Erros: {len(errors)}"
    )

    if errors:
        print()
        print("Arquivos com erro:")

        for filename, error in errors:
            print(
                f"- {filename}: {error}"
            )


if __name__ == "__main__":
    main()