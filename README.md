# J.A.R.V.I.S.

Assistente por voz no navegador, inspirado no JARVIS do Homem de Ferro. Você fala, ele responde com voz e, quando o assunto pode ser visto, monta um holograma 3D simplificado que você pega, gira e desmonta com as mãos pela câmera.

Site: https://enio-123.github.io/JARVIS/

## Como usar
1. Abra o site (precisa de https, por exemplo GitHub Pages).
2. Cole a sua chave da Groq (console.groq.com/keys). Ela fica salva só no seu navegador e só é enviada para a própria Groq.
3. Clique em Iniciar e converse. Toque no JARVIS (ou aperte Espaço) para interromper a fala.
4. No celular, dá para instalar pelo menu do navegador ("Adicionar à tela inicial").

## O que ele faz
- **Conversa por voz** com a personalidade do JARVIS dos filmes. A resposta começa a ser falada enquanto o resto ainda está sendo gerado.
- **Hologramas 3D**: o modelo se "imprime" de baixo para cima; quando ele cita uma peça entre colchetes, ela acende e ganha uma etiqueta.
- **Anatomia de verdade**: coração, cérebro, esqueleto, órgãos do tronco, sistema respiratório e corpo inteiro vêm de um atlas anatômico real (BodyParts3D), com as peças em português para ele apontar e você separar com as mãos. Cada modelo só é baixado quando é pedido.
- **Para de falar quando ouve "Jarvis"**: dá para interromper no meio da resposta só dizendo o nome dele, mesmo com o som saindo pelo alto-falante.
- **Trilha do Tony Stark**: Back In Black, Shoot To Thrill, Highway to Hell, Thunderstruck e outras do AC/DC, tocadas pelo player oficial do YouTube (nenhum áudio é copiado para o site). O volume abaixa quando alguém fala. Com música tocando, ele só responde quando você diz "Jarvis".
- **Hora e clima** de onde você está (Open-Meteo e BigDataCloud, sem chave), na saudação e quando você pergunta.
- **Timers** ("Jarvis, me avisa em 10 minutos") e **memória** ("lembra que eu gosto de astronomia"), salvos só no navegador.
- **Protocolos dos filmes**: "protocolo festa em casa" e "protocolo casa limpa".

## Gestos
- A mão aparece na tela como um holograma: a mira trava no que está embaixo dela, o arco entre o polegar e o indicador mostra a pinça fechando e uma linha liga a mão ao que ela está segurando
- **Pinça** (polegar + indicador): pega e move o holograma; girar o pulso gira
- **Pinça rápida**: separa as peças (vista explodida) ou junta de novo
- **Pinça com o dedo médio**: pega uma peça
- **Duas mãos**: giram e mudam o tamanho
- **Arremessar**: descarta o holograma
- Sem câmera: mouse (arrastar = mover, clique = separar, botão direito = peça, rodinha = tamanho) ou o dedo na tela (dois dedos giram e mudam o tamanho)

## Atalhos
Espaço interrompe a fala, M pausa o microfone, C liga ou desliga a câmera.

## Voz
- **Piper Faber** (padrão): voz neural pt-BR que roda no navegador, num Worker; baixa 63 MB na primeira vez e fica em cache
- **ElevenLabs**: a mais realista, precisa de chave própria
- **Microsoft neural**: vozes "Natural" que o Edge oferece
- **Voz do sistema**: reserva

## Tecnologia
- Groq: `whisper-large-v3-turbo` para transcrever e o melhor modelo de conversa disponível na chave (prefere `openai/gpt-oss-120b`, com troca automática se um modelo bater no limite)
- Three.js 0.160, MediaPipe Hand Landmarker 0.10.14, onnxruntime-web 1.18 + piper-phonemize para a voz Piper
- Fontes Michroma e Inter (licença OFL, em `vendor/fonts`)
- Sons da interface sintetizados com Web Audio (nenhum arquivo de áudio)
- Modelos de anatomia: BodyParts3D 4.0, © The Database Center for Life Science, licença CC BY 4.0 (detalhes em `assets/anatomia/ATRIBUICAO.md`). Gerados por `tools/anatomia.mjs` e comprimidos com meshoptimizer (MIT)
- Sem etapa de build. Publicação automática no GitHub Pages a cada push na `main`.
