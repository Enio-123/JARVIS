# JARVIS

Assistente por voz no navegador. Você fala, ele responde com voz e, quando o assunto pode ser visto, monta um modelo 3D simplificado que você pega e gira com as mãos pela câmera.

## Como usar
1. Abra o site (precisa de https, por exemplo GitHub Pages).
2. Cole a sua chave da Groq (console.groq.com/keys). Ela fica salva só no seu navegador.
3. Clique em Iniciar e converse. Toque no JARVIS (ou aperte Espaço) para interromper a fala.

## Gestos
- **Pinça** (polegar + indicador): pega e move o modelo; girar o pulso gira
- **Pinça com o dedo médio**: pega uma peça do modelo
- **Duas mãos**: giram e mudam o tamanho
- Sem câmera: mouse (esquerdo = modelo, direito = peça, rodinha = tamanho)

## Voz
- **Piper Faber** (padrão): voz neural pt-BR que roda no navegador; baixa 63 MB na primeira vez e fica em cache
- **ElevenLabs**: a mais realista, precisa de chave própria
- **Microsoft neural**: vozes "Natural" que o Edge oferece
- **Voz do sistema**: reserva

## Tecnologia
- Groq: `whisper-large-v3-turbo` para transcrever e o melhor modelo de conversa disponível na chave (prefere `openai/gpt-oss-120b`)
- Three.js 0.160, MediaPipe Hand Landmarker 0.10.14, onnxruntime-web 1.18 + piper-phonemize para a voz Piper
- Sem etapa de build. Publicação automática no GitHub Pages a cada push na `main`.
