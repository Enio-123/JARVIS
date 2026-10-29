# Modelos de anatomia: créditos

BodyParts3D, © The Database Center for Life Science, licenciado sob CC Attribution 4.0 International.

- Licença do banco de dados: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html
- Download original: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
- Termos da licença: https://creativecommons.org/licenses/by/4.0/
- Publicação: Mitsuhashi et al. (2009), BodyParts3D: 3D structure database for anatomical concepts. https://doi.org/10.1093/nar/gkn613

Usamos a conversão do BodyParts3D 4.0 feita pelo projeto human-atlas (https://github.com/ashemag/human-atlas, dados também em CC BY 4.0): eixos e unidades em metros com Y para cima, geometria simplificada com meshoptimizer.

O que mudamos aqui (tools/anatomia.mjs):
- as peças foram juntadas em grupos com nomes em português (por exemplo, os giros do córtex viraram os lobos do cérebro);
- a parede dos ventrículos foi dividida em ventrículo esquerdo e direito pela cavidade mais próxima;
- os pulmões não existem no atlas (só a árvore dos brônquios): foram gerados a partir do espaço dentro da caixa torácica, acima do diafragma e fora do mediastino, e divididos em lobos pelos brônquios de cada lobo. São uma aproximação, não uma peça do atlas;
- os vasos foram cortados perto do coração e a pele foi recortada no modelo de órgãos;
- cada grupo foi simplificado e comprimido (posições quantizadas em 16 bits, normais em 8 bits).

O BodyParts3D representa um homem adulto de referência. É material educativo, não serve para diagnóstico.
