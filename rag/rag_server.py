"""
API HTTP local para o RAG (busca + resposta com Qwen3 14B) já existente
nesta pasta. Nunca duplica lógica: reaproveita search_knowledge.py
(recuperação/roteamento/diversidade) e answer_with_ai.py (prompt/geração)
diretamente.

Só ouve em 127.0.0.1:8992 (loopback) — nunca 0.0.0.0, nunca exposta na rede.
Sem integração com o app principal, sem Tailscale, sem API externa.
"""
import sys
import time
from typing import Dict, List, Optional

import requests
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Mesma pasta — reaproveita tudo, nunca duplica.
import search_knowledge as sk
import answer_with_ai as ai


HOST = "127.0.0.1"
PORT = 8992

OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
OLLAMA_HEALTHCHECK_TIMEOUT_S = 5

app = FastAPI(title="Mibro RAG local", version="1.0.0")


class SearchRequest(BaseModel):
    query: str
    limit: int = Field(default=5, ge=1, le=20)


class HistoryTurn(BaseModel):
    role: str
    content: str


class AnswerRequest(BaseModel):
    message: str
    chunks: int = Field(default=ai.DEFAULT_CHUNKS, ge=ai.MIN_CHUNKS, le=ai.MAX_CHUNKS)
    # Opcional — igual à Knowledge, nunca a conversa inteira: quem decide o
    # recorte (últimas N mensagens) é o app (ver bot-ai-shadow-service.js),
    # este endpoint só limita de novo por segurança (MAX_HISTORY_TURNS).
    history: List[HistoryTurn] = Field(default_factory=list)


def _ollama_online() -> bool:
    try:
        response = requests.get(OLLAMA_TAGS_URL, timeout=OLLAMA_HEALTHCHECK_TIMEOUT_S)
        return response.ok
    except requests.exceptions.RequestException:
        return False


def _knowledge_ready() -> bool:
    try:
        collection = sk.get_collection()
        return collection.count() > 0
    except Exception:
        return False


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "message": message})


PUBLIC_EXCERPT_CHARS = 400


def _result_to_public(item: Dict) -> Dict:
    metadata = item["metadata"]

    return {
        "arquivo": metadata.get("relative_path", ""),
        "heading": metadata.get("heading", ""),
        "product": metadata.get("product", ""),
        "topic": metadata.get("topic", ""),
        "type": metadata.get("type", ""),
        "origem": item["origin"],
        "distancia": round(item["distance"], 4),
        # Trecho curto só para "Ver trecho" na UI (simulador) — nunca o
        # texto completo do chunk, e nunca usado pelo motor de decisão.
        "trecho": (item.get("document") or "").strip()[:PUBLIC_EXCERPT_CHARS],
    }


@app.get("/health")
def health():
    ollama_online = _ollama_online()
    knowledge_ready = _knowledge_ready()

    return {
        "status": "ONLINE" if (ollama_online and knowledge_ready) else "DEGRADED",
        "ollama": ollama_online,
        "embeddingModel": sk.EMBED_MODEL,
        "generationModel": ai.CHAT_MODEL,
        "knowledgeReady": knowledge_ready,
    }


@app.post("/search")
def search(body: SearchRequest):
    query = body.query.strip()

    if not query:
        return _error_response(400, "EMPTY_QUERY", "Informe uma pergunta em 'query'.")

    try:
        collection = sk.get_collection()
    except Exception as exc:
        return _error_response(503, "KNOWLEDGE_UNAVAILABLE", f"Base local do RAG indisponível: {exc}")

    try:
        outcome = sk.retrieve(query, limit=body.limit, collection=collection)
    except requests.exceptions.ConnectionError:
        return _error_response(503, "OLLAMA_OFFLINE", "Não foi possível conectar ao Ollama em http://127.0.0.1:11434.")
    except requests.exceptions.Timeout:
        return _error_response(504, "EMBEDDING_TIMEOUT", "Tempo limite excedido ao gerar o embedding da pergunta.")
    except Exception as exc:
        return _error_response(500, "SEARCH_FAILED", str(exc))

    return {
        "query": query,
        "product": outcome["product"],
        "intent": outcome["routing_name"],
        "results": [_result_to_public(item) for item in outcome["results"]],
    }


@app.post("/answer")
def answer(body: AnswerRequest):
    message = body.message.strip()

    if not message:
        return _error_response(400, "EMPTY_MESSAGE", "Informe uma mensagem em 'message'.")

    history = [turn.model_dump() for turn in body.history]

    try:
        result = ai.generate_answer(message, chunks=body.chunks, history=history)
    except ai.KnowledgeUnavailableError as exc:
        return _error_response(503, "KNOWLEDGE_UNAVAILABLE", f"Base local do RAG indisponível: {exc}")
    except requests.exceptions.ConnectionError:
        return _error_response(503, "OLLAMA_OFFLINE", "Não foi possível conectar ao Ollama em http://127.0.0.1:11434.")
    except requests.exceptions.Timeout:
        return _error_response(504, "GENERATION_TIMEOUT", f"Tempo limite excedido ao consultar o Ollama (até {ai.CHAT_TIMEOUT_S}s).")
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        if status == 404:
            return _error_response(502, "MODEL_NOT_FOUND", f"Modelo '{ai.CHAT_MODEL}' não encontrado no Ollama (confira `ollama list`).")
        return _error_response(502, "OLLAMA_HTTP_ERROR", str(exc))
    except Exception as exc:
        return _error_response(500, "ANSWER_FAILED", str(exc))

    return {
        "answer": result["answer"],
        "action": result["action"],
        "confidence": result["confidence"],
        "needsHuman": result["needsHuman"],
        "reason": result["reason"],
        "product": result["product"],
        "intent": result["intent"],
        "sources": result["sources"],
        # Detalhe dos chunks usados — só para depuração/UI (simulador). Nunca
        # o conteúdo bruto do chunk aqui: mesma função que /search já usa
        # (_result_to_public), reaproveitada, sem duplicar formatação.
        "sourceDetails": [_result_to_public(item) for item in result["usedResults"]],
        "searchMs": round(result["searchElapsedS"] * 1000) if result.get("searchElapsedS") is not None else None,
        "generationMs": round(result["generationElapsedS"] * 1000) if result.get("generationElapsedS") is not None else None,
        "latencyMs": result["latencyMs"],
    }


if __name__ == "__main__":
    import uvicorn

    # host fixo em loopback — nunca 0.0.0.0 nesta etapa (item explícito do
    # pedido: não expor na rede, não abrir porta no firewall).
    uvicorn.run(app, host=HOST, port=PORT)
