// Contrato que qualquer provider de IA usado pelo interpretador de Bots deve seguir.
// Nenhuma parte do motor deve depender diretamente de um provider específico.

class AIProvider {
  // Deve retornar { intentId, confidence, entities } ou null quando não conseguir classificar.
  async classifyIntent(_input) {
    throw new Error("classifyIntent não implementado neste provider.");
  }

  // Deve retornar um objeto de entidades brutas (validadas depois pelo chamador).
  async extractEntities(_input) {
    throw new Error("extractEntities não implementado neste provider.");
  }

  // Reescreve `groundingText` no tom/estilo descrito por `systemPrompt`
  // (Personalidade do Bot — ver bot-personality-service.js), sem adicionar
  // nem remover informação. Deve devolver `{ text, usage }` ou uma string
  // simples (providers sem custo por token, como o LOCAL, podem devolver só
  // o texto). NUNCA deve inventar conteúdo além do que já está em
  // `groundingText` — o chamador (bot-personality-service.js) trata
  // qualquer erro como "sem reescrita", nunca deixa a resposta sem sair.
  async generateResponse(_input) {
    throw new Error("generateResponse não implementado neste provider.");
  }
}

module.exports = { AIProvider };
