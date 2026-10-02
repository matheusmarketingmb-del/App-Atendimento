"""
Testes dos 10 cenários pedidos + checagem de texto excessivo (item "TESTES
OBRIGATÓRIOS"/"TESTE DE TEXTO EXCESSIVO"). Sem pytest — o projeto não usa
framework de teste nenhum ainda (rag/requirements.txt não tem um), então
isto segue o mesmo estilo simples dos outros scripts da pasta: asserts +
runner próprio, `python test_planner.py`.

Dois grupos:
- PURE: sem rede, sempre rodáveis (lógica de histórico/roteamento isolada).
- INTEGRATION: chamam generate_answer() de verdade — precisam do Ollama
  (qwen3:14b + nomic-embed-text) e do ChromaDB locais rodando. Não travam a
  parte PURE se Ollama estiver offline (reportam FAIL nesse teste, não
  derrubam o script inteiro).
"""
import sys
import time
import traceback
from typing import Callable, List, Tuple

import answer_with_ai as ai

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# Heurística simples de "texto excessivo" (item "TESTE DE TEXTO EXCESSIVO":
# "pode usar uma checagem simples de tamanho/estrutura, sem depender de IA
# externa") — não é uma verdade absoluta, só um sinal de alerta.
def looks_like_raw_dump(answer: str) -> bool:
    if len(answer) > 900:
        return True
    if answer.count("\n") >= 4:
        return True
    if answer.count("#") >= 2:
        return True
    if answer.lower().count("fonte ") >= 1:
        return True
    return False


def test_history_reference_resolution_pure():
    history = [
        {"role": "customer", "content": "meu relogio nao carrega"},
        {"role": "assistant", "content": "Qual e o modelo?"},
    ]
    query = ai.build_retrieval_query("GS Pro 2", history)
    assert "GS Pro 2" in query, f"query perdeu o produto: {query!r}"
    assert "carrega" in query, f"query perdeu o problema original: {query!r}"


def test_topic_change_not_merged_pure():
    history = [
        {"role": "customer", "content": "meu GS Pro 2 nao carrega"},
        {"role": "assistant", "content": "Confira os contatos do carregador."},
    ]
    query = ai.build_retrieval_query("quanto custa o Lite 3 Pro?", history)
    assert query == "quanto custa o Lite 3 Pro?", f"mensagem longa não devia herdar histórico: {query!r}"


def test_short_reply_without_history_pure():
    query = ai.build_retrieval_query("GS Pro 2", [])
    assert query == "GS Pro 2", f"sem histórico, query deve ficar igual à mensagem: {query!r}"


def test_history_block_truncates_pure():
    history = [{"role": "customer", "content": "x" * 1000}]
    block = ai.build_history_block(history)
    assert len(block) < 350, f"história por turno devia ser truncada: {len(block)} chars"


def test_history_block_limits_turns_pure():
    history = [{"role": "customer", "content": f"msg {i}"} for i in range(30)]
    block = ai.build_history_block(history)
    assert block.count("Cliente:") <= ai.MAX_HISTORY_TURNS


def test_parse_structured_reply_rejects_malformed_pure():
    assert ai.parse_structured_reply("isto nao e json") is None
    assert ai.parse_structured_reply('{"answer": "oi"}') is None  # faltam campos obrigatórios
    assert ai.parse_structured_reply(
        '{"answer": "oi", "action": "RESPOND", "confidence": "HIGH", "needsHuman": false, "reason": "x"}'
    ) is not None


def test_human_request_fast_path_pure():
    started = time.perf_counter()
    result = ai.generate_answer("quero falar com uma pessoa")
    elapsed = time.perf_counter() - started
    assert result["action"] == "HANDOFF"
    assert result["needsHuman"] is True
    assert result["reason"] == "customer_requested_human"
    assert result["sources"] == 0
    assert elapsed < 1.0, "pedido explícito de humano não deveria chamar Knowledge/Ollama"


def test_safety_hazard_forces_handoff_integration():
    result = ai.generate_answer("meu relogio esta quente e a tela levantou")
    assert result["action"] == "HANDOFF"
    assert result["needsHuman"] is True
    assert result["reason"] == "safety_hazard"


def test_charging_short_response_integration():
    result = ai.generate_answer("meu GS Pro 2 nao carrega")
    assert not looks_like_raw_dump(result["answer"]), f"resposta parece dump bruto: {result['answer']!r}"
    assert result["action"] in ai.VALID_ACTIONS
    assert result["confidence"] in ai.VALID_CONFIDENCE


def test_history_carries_context_integration():
    history = [
        {"role": "customer", "content": "meu relogio nao carrega"},
        {"role": "assistant", "content": "Qual e o modelo?"},
    ]
    result = ai.generate_answer("GS Pro 2", history=history)
    assert result["product"] == "GS Pro 2"
    assert result["intent"] == "charging"
    assert not looks_like_raw_dump(result["answer"])


def test_warranty_not_full_policy_integration():
    result = ai.generate_answer("como funciona a garantia?")
    assert not looks_like_raw_dump(result["answer"]), f"resposta de garantia parece política inteira: {result['answer']!r}"


def test_returns_not_full_policy_integration():
    result = ai.generate_answer("como funciona a devolucao?")
    assert not looks_like_raw_dump(result["answer"]), f"resposta de devolução parece política inteira: {result['answer']!r}"


def test_resolve_after_confirmation_integration():
    history = [
        {"role": "customer", "content": "meu GS Pro 2 nao carrega"},
        {"role": "assistant", "content": "Confira se os contatos do relogio e do carregador estao limpos e secos."},
    ]
    result = ai.generate_answer("funcionou", history=history)
    assert result["action"] == "RESOLVE", f"esperado RESOLVE, veio {result['action']}"


def test_unknown_feature_never_affirms_integration():
    result = ai.generate_answer("o GS Explorer S faz pagamento por aproximacao?")
    lowered = result["answer"].lower()
    # Nunca pode afirmar categoricamente sim/não sobre uma função DESCONHECIDA.
    assert "não possui pagamento" not in lowered
    assert "não suporta pagamento" not in lowered
    assert "sim, o gs explorer s" not in lowered
    assert result["confidence"] in {"MEDIUM", "LOW"}, f"confidence deveria ser conservadora, veio {result['confidence']}"


PURE_TESTS: List[Tuple[str, Callable]] = [
    (name, fn) for name, fn in list(globals().items())
    if name.startswith("test_") and name.endswith("_pure")
]
INTEGRATION_TESTS: List[Tuple[str, Callable]] = [
    (name, fn) for name, fn in list(globals().items())
    if name.startswith("test_") and name.endswith("_integration")
]


def run(tests: List[Tuple[str, Callable]], label: str) -> int:
    print(f"\n=== {label} ===")
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  OK   {name}")
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL {name}: {exc}")
        except Exception:
            failures += 1
            print(f"  ERROR {name}")
            traceback.print_exc()
    return failures


def main():
    failures = run(sorted(PURE_TESTS), "PURE (sem rede)")
    failures += run(sorted(INTEGRATION_TESTS), "INTEGRATION (Ollama + ChromaDB locais)")
    print(f"\n{len(PURE_TESTS) + len(INTEGRATION_TESTS) - failures} ok, {failures} falha(s).")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
