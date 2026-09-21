from pathlib import Path
import argparse
import re
import sys
from typing import Dict, List, Optional, Tuple

import chromadb
import requests

# O console do Windows (cp1252) não mapeia todo caractere Unicode presente
# na Knowledge (ex.: subscritos/símbolos técnicos) — sem isso, `print()`
# derruba o script no meio dos resultados com UnicodeEncodeError em vez de
# só exibir os acentos errados. errors="replace" nunca lança, só substitui o
# caractere não mapeável.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CHROMA_DIR = Path(r"C:\App Whats\rag\chroma_db")

OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings"
EMBED_MODEL = "nomic-embed-text"

COLLECTION_NAME = "mibro_knowledge"

# Boost multiplicativo aplicado à distância (menor = mais relevante) quando
# um chunk bate com o produto detectado/roteamento de intenção. Distâncias
# aqui são L2 bruta (dezenas/centenas, não 0-2 de cosine normalizada) — por
# isso o boost é uma FRAÇÃO da própria distância, nunca um valor fixo (um
# fixo seria irrelevante numa escala ou desproporcional noutra). Os
# resultados de outra origem NUNCA são removidos, só reordenados (item
# "não remover resultados semanticamente úteis só porque são de outro tipo").
PRODUCT_MATCH_DISCOUNT = 0.18
TOPIC_MATCH_DISCOUNT = 0.15
MAX_DISCOUNT = 0.30

# Tamanho do pool candidato por sub-busca (produto/roteamento/semântica) antes
# de mesclar e cortar para `limit` — maior que `limit` para dar chance de um
# resultado de outra origem entrar na mescla final.
POOL_MULTIPLIER = 4
MIN_POOL_SIZE = 20

# Item "evitar excesso de chunks do mesmo arquivo": no recorte final, nunca
# mais que isso do MESMO arquivo — mesmo que ele domine o ranking bruto.
# Nunca remove o arquivo inteiro, só limita quantos pedaços dele entram.
MAX_CHUNKS_PER_FILE = 2

# Tipos considerados "fluxo/garantia" para o bônus opcional de diversidade
# (item 3) — nunca obrigatório, só usado se já houver um candidato natural.
FLOW_WARRANTY_TYPES = {"bot_flow", "warranty"}

# Item 6 (charging): um heading sobre compatibilidade de carregador ENTRE
# MODELOS só é relevante se a própria pergunta mencionar isso — para uma
# pergunta simples de "não carrega", é ruído que rouba espaço de headings
# realmente acionáveis (contatos, primeiros testes). Só reordena (multiplica
# a distância), nunca remove.
CHARGING_CROSS_MODEL_HEADING_HINTS = ["outro modelo", "outro carregador", "carregador de outro"]
CHARGING_CROSS_MODEL_QUERY_HINTS = [
    "outro modelo", "compativel", "compatível", "compatibilidade", "mesmo carregador", "carregador do",
]
CHARGING_HEADING_PENALTY = 0.25

# Penalidade para um chunk com `product` preenchido DIFERENTE do produto já
# detectado na pergunta (ex.: pergunta sobre "GS Pro" trazendo um chunk cujo
# `product` é "Earbuds Open Ear Pro") — contaminação cruzada entre produtos.
# Só reordena, nunca remove; chunks sem `product` (gerais) nunca são
# afetados por esta penalidade.
CROSS_PRODUCT_PENALTY = 0.35


KNOWN_PRODUCTS = [
    "GS Explorer S",
    "GS Explorer",
    "GS Active2",
    "GS Active 2",
    "GS Active",
    "GS Pro 2",
    "GS Pro",
    "Lite 3 Pro",
    "Lite 3",
    "Mibro FIT",
    "Mibro GT",
    "Earbuds Open Ear Pro",
    "Earbuds Open Ear",
    "Earbuds 5",
    "A3",
    "C4",
]


def normalize_product_name(name: str) -> str:
    aliases = {
        "GS Active 2": "GS Active2",
    }

    return aliases.get(name, name)


def detect_product(query: str) -> Optional[str]:
    query_lower = query.lower()

    sorted_products = sorted(
        KNOWN_PRODUCTS,
        key=len,
        reverse=True,
    )

    for product in sorted_products:
        if product.lower() in query_lower:
            return normalize_product_name(product)

    return None


# Roteamento simples por intenção (item "melhorar relevância"): cada regra é
# só um conjunto de palavras/padrões — nunca um classificador de verdade.
# `boost_types`/`boost_topics` batem contra os MESMOS valores gravados por
# index_knowledge.py (type/topic do front matter). Usado só para REORDENAR
# (ver PRODUCT_MATCH_DISCOUNT/TOPIC_MATCH_DISCOUNT acima), nunca para
# excluir um resultado que a busca semântica já achou relevante.
INTENT_RULES: List[Tuple[str, List[str], List[str], List[str]]] = [
    (
        "returns_refunds",
        [
            "devolver", "devolucao", "devolução", "reembolso", "arrependimento",
            "arrependi", "desistir da compra", "cancelar a compra", "quero o dinheiro de volta",
            "trocar o produto", "quero trocar",
        ],
        # Nunca "policy" inteiro aqui — type=policy também cobre
        # shipping_policy/privacy_terms (política de ENVIO/privacidade),
        # que contaminariam devolução voluntária com devolução ao remetente
        # logística. Só o TOPIC específico de devolução/reembolso entra.
        ["returns_refunds"],
        ["return", "withdrawal", "refund", "refund_policy", "exchange"],
    ),
    (
        "wholesale",
        [
            "atacado", "revenda", "revender", "revendedor", "cnpj", "minha loja",
            "lojista", "comprar para revender", "comprar em quantidade", "cotacao", "cotação",
        ],
        # "bot_flow" sozinho casaria TODOS os fluxos (suporte/garantia
        # inclusive) — o topic específico abaixo já cobre exatamente
        # comercial/triagem/handoff, sem precisar do type inteiro.
        ["wholesale"],
        [
            "wholesale_general", "reseller_registration", "quotation", "wholesale_payment",
            "commercial_flow", "initial_triage", "human_handoff",
        ],
    ),
    (
        "charging",
        [
            "nao carrega", "não carrega", "carregamento", "carregando", "nao liga",
            "não liga", "bateria descarregando rapido", "bateria descarregando rápido",
        ],
        # "support" sozinho casaria a pasta 03_Suporte inteira (mesmo erro
        # já corrigido em "policy" acima) — só o topic específico entra.
        [],
        ["charging", "battery"],
    ),
    (
        "gps",
        [
            "gps", "localizacao", "localização", "satelite", "satélite", "gnss",
            "glonass", "beidou", "galileo", "l1", "l5", "dupla frequencia", "dupla frequência",
        ],
        [],
        ["gps_location"],
    ),
]

# "20 unidades"/"30 relógios"/"50 peças" — padrão numérico de quantidade que
# também indica intenção de atacado, além das palavras-chave literais acima.
WHOLESALE_QUANTITY_PATTERN = re.compile(
    r"\b\d{1,4}\s*(unidades?|rel[oó]gios?|pe[cç]as?|smartwatch(es)?)\b",
    re.IGNORECASE,
)


def detect_intent(query: str) -> Optional[Tuple[str, List[str], List[str]]]:
    query_lower = query.lower()

    if WHOLESALE_QUANTITY_PATTERN.search(query_lower):
        for name, _keywords, boost_types, boost_topics in INTENT_RULES:
            if name == "wholesale":
                return name, boost_types, boost_topics

    for name, keywords, boost_types, boost_topics in INTENT_RULES:
        if any(keyword in query_lower for keyword in keywords):
            return name, boost_types, boost_topics

    return None


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


def build_where_filter(
    product: Optional[str] = None,
    topic: Optional[str] = None,
    type_: Optional[str] = None,
) -> Optional[Dict]:
    conditions = []

    if product:
        conditions.append(
            {"product": product}
        )

    if topic:
        conditions.append(
            {"topic": topic}
        )

    if type_:
        conditions.append(
            {"type": type_}
        )

    if not conditions:
        return None

    if len(conditions) == 1:
        return conditions[0]

    return {
        "$and": conditions
    }


def build_routing_where(
    boost_types: List[str],
    boost_topics: List[str],
) -> Optional[Dict]:
    conditions = []

    if boost_types:
        conditions.append({"type": {"$in": boost_types}})

    if boost_topics:
        conditions.append({"topic": {"$in": boost_topics}})

    if not conditions:
        return None

    if len(conditions) == 1:
        return conditions[0]

    return {"$or": conditions}


def run_query(collection, query_embedding: List[float], n_results: int, where: Optional[Dict] = None):
    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": n_results,
        "include": ["documents", "metadatas", "distances"],
    }

    if where:
        query_kwargs["where"] = where

    return collection.query(**query_kwargs)


def merge_candidates(candidates: Dict[str, Dict], results, origin: str) -> None:
    """
    Mescla um resultado de sub-busca (`origin` = PRODUCT/TOPIC/SEMANTIC) no
    dicionário acumulador por id — nunca substitui um candidato já visto por
    um pior, e nunca perde a origem PRODUCT (a mais específica) quando um
    mesmo chunk aparece em mais de uma sub-busca.
    """
    ids = results.get("ids", [[]])[0]
    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    origin_priority = {"PRODUCT": 2, "TOPIC": 1, "SEMANTIC": 0}

    for chunk_id, document, metadata, distance in zip(ids, documents, metadatas, distances):
        entry = candidates.get(chunk_id)

        if entry is None:
            candidates[chunk_id] = {
                "id": chunk_id,
                "document": document,
                "metadata": metadata,
                "distance": distance,
                "matched_product": origin == "PRODUCT",
                "matched_topic": origin == "TOPIC",
                "best_origin": origin,
            }
            continue

        entry["matched_product"] = entry["matched_product"] or (origin == "PRODUCT")
        entry["matched_topic"] = entry["matched_topic"] or (origin == "TOPIC")

        if origin_priority[origin] > origin_priority[entry["best_origin"]]:
            entry["best_origin"] = origin

        if distance < entry["distance"]:
            entry["distance"] = distance


def _dedupe_same_heading(ranked: List[Dict]) -> List[Dict]:
    """
    Item "evitar duplicação semântica": dois chunks do MESMO arquivo+heading
    são, quase sempre, o mesmo trecho grande partido em pedaços por
    split_large_text (index_knowledge.py) — mantém só o melhor (menor
    adjusted_distance) de cada grupo, nunca os dois.
    """
    best_by_group: Dict[Tuple[str, str], Dict] = {}

    for item in ranked:
        key = (item["metadata"].get("relative_path", ""), item["metadata"].get("heading", ""))
        current = best_by_group.get(key)

        if current is None or item["adjusted_distance"] < current["adjusted_distance"]:
            best_by_group[key] = item

    return sorted(best_by_group.values(), key=lambda item: item["adjusted_distance"])


def _cap_per_file(ranked: List[Dict], max_per_file: int) -> List[Dict]:
    counts: Dict[str, int] = {}
    capped = []

    for item in ranked:
        file_key = item["metadata"].get("relative_path", "")

        if counts.get(file_key, 0) >= max_per_file:
            continue

        counts[file_key] = counts.get(file_key, 0) + 1
        capped.append(item)

    return capped


# Núcleo de ranqueamento: aplica os boosts de produto/roteamento (item
# "melhorar relevância", turno anterior) + o ajuste fino de heading do item 6
# + desduplicação por heading (item 2) + limite por arquivo (item 1). Nunca
# corta para `limit` aqui — quem chama decide o corte final (e, no caminho
# automático, ainda pode aplicar a garantia de diversidade do item 3 antes
# de cortar).
def rank_candidates(
    candidates: Dict[str, Dict],
    max_per_file: int = MAX_CHUNKS_PER_FILE,
    routing_name: Optional[str] = None,
    query_lower: str = "",
    detected_product: Optional[str] = None,
) -> List[Dict]:
    ranked = []

    query_asks_about_compat = any(hint in query_lower for hint in CHARGING_CROSS_MODEL_QUERY_HINTS)

    for entry in candidates.values():
        heading_lower = str(entry["metadata"].get("heading", "")).lower()

        # Item 6: um heading sobre compatibilidade entre carregadores de
        # OUTRO MODELO só é bônus de tópico se a pergunta realmente pedir
        # isso — senão, é um falso-positivo do roteamento "charging" (o
        # heading fala de carregador/GS Pro 2, mas não do problema em si).
        # Continuar dando o desconto de tópico E aplicar a penalidade ao
        # mesmo tempo anularia uma coisa com a outra; aqui elas se excluem.
        cross_model_heading_penalized = (
            routing_name == "charging"
            and not query_asks_about_compat
            and any(hint in heading_lower for hint in CHARGING_CROSS_MODEL_HEADING_HINTS)
        )

        # Um produto já foi detectado com confiança na pergunta (ex.: "GS
        # Pro") e este chunk tem `product` PREENCHIDO com um produto
        # DIFERENTE (ex.: "Earbuds Open Ear Pro") — sinal de contaminação
        # cruzada entre produtos (item explícito do pedido: "não trazer
        # fones ou produtos não relacionados entre os principais chunks").
        # Nunca remove (a busca semântica pode ter achado algo genuinamente
        # útil), só reordena para trás — mesmo espírito de
        # cross_model_heading_penalized acima. Chunk SEM produto (geral,
        # ex.: carregamento.md) nunca é penalizado aqui.
        chunk_product = entry["metadata"].get("product")
        cross_product_penalized = bool(
            detected_product and chunk_product and chunk_product != detected_product
        )

        discount = 0.0

        if entry["matched_product"]:
            discount += PRODUCT_MATCH_DISCOUNT

        if entry["matched_topic"] and not cross_model_heading_penalized:
            discount += TOPIC_MATCH_DISCOUNT

        discount = min(discount, MAX_DISCOUNT)

        adjusted_distance = entry["distance"] * (1 - discount)

        if cross_model_heading_penalized:
            adjusted_distance *= (1 + CHARGING_HEADING_PENALTY)

        if cross_product_penalized:
            adjusted_distance *= (1 + CROSS_PRODUCT_PENALTY)

        origin = "PRODUCT" if entry["matched_product"] else ("TOPIC" if entry["matched_topic"] else "SEMANTIC")

        ranked.append({**entry, "adjusted_distance": adjusted_distance, "origin": origin})

    ranked.sort(key=lambda item: item["adjusted_distance"])
    ranked = _dedupe_same_heading(ranked)
    ranked = _cap_per_file(ranked, max_per_file)

    return ranked


def _worst_replaceable_index(selected: List[Dict], protected_origins: set) -> Optional[int]:
    worst_index = None
    worst_distance = -1.0

    for index, item in enumerate(selected):
        if item["origin"] in protected_origins:
            continue

        if item["adjusted_distance"] > worst_distance:
            worst_distance = item["adjusted_distance"]
            worst_index = index

    return worst_index


def ensure_support_diversity(
    ranked_full: List[Dict],
    limit: int,
    product: Optional[str],
    routing_name: Optional[str],
) -> List[Dict]:
    """
    Item 3 ("preservar diversidade"): numa consulta de suporte com produto
    identificado, tenta garantir pelo menos 1 chunk de origem PRODUCT e 1 de
    origem TOPIC no recorte final, e opcionalmente 1 de fluxo/garantia.
    Item 4 ("não forçar categorias inexistentes"): só troca quando existe de
    verdade um candidato daquela origem no pool — sem candidato, o ranking
    semântico normal permanece intacto. Só usada no caminho AUTOMÁTICO
    (nunca em --product/--topic/--type manual — ver retrieve()).
    """
    selected = list(ranked_full[:limit])

    if not product or not routing_name:
        return selected

    remaining = list(ranked_full[limit:])
    protected_origins: set = set()

    for origin in ("PRODUCT", "TOPIC"):
        if any(item["origin"] == origin for item in selected):
            protected_origins.add(origin)
            continue

        candidate = next((item for item in remaining if item["origin"] == origin), None)

        if candidate is None:
            continue

        worst_index = _worst_replaceable_index(selected, protected_origins)

        if worst_index is None:
            continue

        remaining.remove(candidate)
        remaining.append(selected[worst_index])
        selected[worst_index] = candidate
        protected_origins.add(origin)

    if not any(item["metadata"].get("type") in FLOW_WARRANTY_TYPES for item in selected):
        candidate = next((item for item in remaining if item["metadata"].get("type") in FLOW_WARRANTY_TYPES), None)

        if candidate is not None:
            worst_index = _worst_replaceable_index(selected, protected_origins)

            if worst_index is not None:
                selected[worst_index] = candidate

    selected.sort(key=lambda item: item["adjusted_distance"])

    return selected


def hybrid_search(
    collection,
    query: str,
    query_embedding: List[float],
    limit: int,
    product: Optional[str],
    routing: Optional[Tuple[str, List[str], List[str]]],
) -> Tuple[List[Dict], bool]:
    """
    Busca semântica ampla (nunca restrita só ao produto — item "produto +
    suporte": um arquivo geral como carregamento.md não tem `product` e
    nunca pode ser excluído só por causa do filtro) complementada por duas
    sub-buscas de reforço (produto detectado / roteamento de intenção), cujo
    único efeito é REORDENAR o que a busca semântica já encontrou. Depois do
    ranking, aplica desduplicação + limite por arquivo (sempre) e a garantia
    de diversidade produto/tópico/fluxo (só quando produto + roteamento
    foram detectados — ver ensure_support_diversity).
    Retorna (resultados, produto_teve_zero_hits_diretos).
    """
    pool_size = max(limit * POOL_MULTIPLIER, MIN_POOL_SIZE)

    candidates: Dict[str, Dict] = {}

    base_results = run_query(collection, query_embedding, pool_size)
    merge_candidates(candidates, base_results, "SEMANTIC")

    product_had_zero_hits = False

    if product:
        product_results = run_query(collection, query_embedding, pool_size, where={"product": product})

        if not product_results.get("ids", [[]])[0]:
            product_had_zero_hits = True
        else:
            merge_candidates(candidates, product_results, "PRODUCT")

    routing_name = routing[0] if routing else None

    if routing:
        _name, boost_types, boost_topics = routing
        routing_where = build_routing_where(boost_types, boost_topics)

        if routing_where:
            topic_results = run_query(collection, query_embedding, pool_size, where=routing_where)
            merge_candidates(candidates, topic_results, "TOPIC")

    # Pool maior que `limit` — dá margem para ensure_support_diversity()
    # trocar o pior item selecionado por um candidato de outra origem sem
    # precisar consultar o Chroma de novo.
    ranked_full = rank_candidates(
        candidates,
        max_per_file=MAX_CHUNKS_PER_FILE,
        routing_name=routing_name,
        query_lower=query.lower(),
        detected_product=product,
    )

    results = ensure_support_diversity(ranked_full, limit, product, routing_name)

    return results, product_had_zero_hits


def print_results(query: str, product: Optional[str], topic: Optional[str], type_: Optional[str], routing_name: Optional[str], results: List[Dict]) -> None:
    print()
    print("=" * 80)
    print(f"BUSCA: {query}")

    if product:
        print(f"Filtro de produto: {product}")

    if topic:
        print(f"Filtro de topic: {topic}")

    if type_:
        print(f"Filtro de type: {type_}")

    if routing_name:
        print(f"Roteamento de intenção: {routing_name}")

    print("=" * 80)

    if not results:
        print("Nenhum resultado encontrado.")
        return

    for index, item in enumerate(results, start=1):
        metadata = item["metadata"]

        print()
        print(f"[{index}]")
        print(f"Distância: {item['distance']:.4f}")
        print(f"Origem: {item['origin']}")
        print(f"Arquivo: {metadata.get('relative_path', '')}")
        print(f"Heading: {metadata.get('heading', '')}")
        print(f"Produto: {metadata.get('product', '')}")
        print(f"Topic: {metadata.get('topic', '')}")
        print(f"Type: {metadata.get('type', '')}")
        print(f"Confidence: {metadata.get('confidence', '')}")
        print("-" * 80)
        print(item["document"])
        print("-" * 80)


def get_collection():
    client = chromadb.PersistentClient(
        path=str(CHROMA_DIR)
    )

    return client.get_collection(
        name=COLLECTION_NAME
    )


# Núcleo de recuperação, separado de qualquer `print()` — reutilizado pela
# CLI (search(), abaixo) e por answer_with_ai.py (item "reutilizar": nunca
# duplicar a lógica de busca/roteamento/híbrido num segundo lugar).
def retrieve(
    query: str,
    limit: int = 5,
    product: Optional[str] = None,
    topic: Optional[str] = None,
    type_: Optional[str] = None,
    collection=None,
) -> Dict:
    collection = collection if collection is not None else get_collection()

    manual_filter = bool(product or topic or type_)
    query_embedding = get_embedding(query)

    # Filtro manual (--product/--topic/--type): comportamento antigo,
    # preservado à parte — nunca "melhorado" às escondidas com roteamento ou
    # busca híbrida. Zero resultados aqui significa zero resultados PARA
    # ESSE FILTRO EXATO; nunca removido/afrouxado silenciosamente.
    if manual_filter:
        where_filter = build_where_filter(product=product, topic=topic, type_=type_)
        raw_results = run_query(collection, query_embedding, limit, where=where_filter)
        merged: Dict[str, Dict] = {}
        merge_candidates(merged, raw_results, "PRODUCT" if product else "TOPIC")
        ranked = rank_candidates(merged)[:limit]

        return {
            "manual_filter": True,
            "product": product,
            "topic": topic,
            "type_": type_,
            "routing_name": None,
            "results": ranked,
            "product_had_zero_hits": False,
        }

    # Caminho automático (item "melhorar relevância" + "produto + suporte"):
    # detecção de produto e roteamento de intenção nunca excluem nada — só
    # reordenam uma busca semântica que já cobre a base inteira.
    detected_product = detect_product(query)
    routing = detect_intent(query)

    results, product_had_zero_hits = hybrid_search(collection, query, query_embedding, limit, detected_product, routing)

    return {
        "manual_filter": False,
        "product": detected_product,
        "topic": None,
        "type_": None,
        "routing_name": routing[0] if routing else None,
        "results": results,
        "product_had_zero_hits": product_had_zero_hits,
    }


def search(
    query: str,
    limit: int = 5,
    product: Optional[str] = None,
    topic: Optional[str] = None,
    type_: Optional[str] = None,
):
    outcome = retrieve(query, limit=limit, product=product, topic=topic, type_=type_)

    if outcome["manual_filter"] and not outcome["results"]:
        print()
        print("=" * 80)
        print(f"BUSCA: {query}")
        print(f"Filtro manual: produto={product or '-'} topic={topic or '-'} type={type_ or '-'}")
        print("=" * 80)
        print("Nenhum resultado para este filtro manual — refine a busca ou remova o filtro.")
        return

    if outcome["product"] and outcome["product_had_zero_hits"]:
        print(
            f"Aviso: filtro automático de produto '{outcome['product']}' não encontrou chunks "
            "específicos desse produto; complementando com a busca semântica geral."
        )

    print_results(
        query, outcome["product"], outcome["topic"], outcome["type_"], outcome["routing_name"], outcome["results"],
    )


def main():
    parser = argparse.ArgumentParser(
        description="Busca local na Knowledge Mibro."
    )

    parser.add_argument(
        "query",
        help="Pergunta ou texto para pesquisar.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Quantidade de resultados.",
    )

    parser.add_argument(
        "--product",
        default=None,
        help="Filtro manual de produto (desliga roteamento/híbrido automático).",
    )

    parser.add_argument(
        "--topic",
        default=None,
        help="Filtro manual por topic (desliga roteamento/híbrido automático).",
    )

    parser.add_argument(
        "--type",
        dest="type_",
        default=None,
        help="Filtro manual por type (desliga roteamento/híbrido automático).",
    )

    args = parser.parse_args()

    search(
        query=args.query,
        limit=args.limit,
        product=args.product,
        topic=args.topic,
        type_=args.type_,
    )


if __name__ == "__main__":
    main()
