// 12-panel spec: "O que apagaram", sincretismo Egito⇄Grécia + África⇄Brasil
// Every claim below is traceable to the attached research document.
// Contested claims are marked `contested: true` and MUST be presented as contested.

const LOOK = 'Split composition, two halves of one frame divided by a single thin vertical seam. '
  + 'Both halves share identical lighting, identical camera height, identical scale. '
  + 'Museum object photography: raking side light, deep shadow falloff, matte surfaces, fine dust in the air. '
  + 'Color grade restricted to terracotta brown, deep night blue, dark green, black and warm bone grey. '
  + 'Absolutely no text, no letters, no numerals, no signage, no watermark, no captions anywhere in the image.';

// Classical statuary prompts must state full drapery explicitly: unqualified "Greek bronze/marble
// statue" prompts are rejected by the image safety filter as nudity.
const CLOTHED = 'The figure is fully clothed in heavy carved drapery covering the torso and legs, modest museum statuary.';

export const PANELS = [
  // ─────────── ATO I, EGITO ⇄ GRÉCIA (4) ───────────
  {
    id: '01-thoth-hermes',
    act: 'I',
    left: 'Thoth', right: 'Hermes',
    title: 'Thoth ⇄ Hermes',
    claim: 'Em Hermópolis, no Egito ptolomaico, Thoth e Hermes eram cultuados como uma só divindade, a fusão que gerou Hermes Trismegisto e todo o corpus hermético.',
    source: 'Documento, §3: interpretatio graeca; Hermópolis, antigo Templo de Thoth.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: ancient Egyptian basalt statue of Thoth, ibis-headed deity holding a scribe palette and reed, dark polished stone, authentic Kemetic regalia and proportions, gallery pedestal. RIGHT HALF: ancient Greek bronze statue of Hermes, wearing a long draped chlamys cloak covering the body, winged sandals and caduceus, patinated bronze, authentic classical Greek proportions, ${CLOTHED}, identical gallery pedestal. The two figures mirror each other's pose and gesture exactly.`
  },
  {
    id: '02-amon-zeus',
    act: 'I',
    left: 'Amon', right: 'Zeus',
    title: 'Amon ⇄ Zeus',
    claim: 'Heródoto, no século V a.C., registrou a equivalência. O culto de Zeus-Amon (Júpiter Amon) juntou o deus oracular egípcio ao céu grego, carneiro e trovão no mesmo altar.',
    source: 'Documento, §3: Heródoto equated Amun→Zeus; Zeus-Ammon / Jupiter Ammon.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: monumental ancient Egyptian granite statue of Amun, ram-horned crown, dark granite, authentic Kemetic carving, gallery pedestal. RIGHT HALF: monumental ancient Greek marble statue of Zeus, bearded, ram's horns curling at the temples in the Zeus-Ammon manner, heavy himation drapery wrapped across the shoulder and lower body, weathered marble, ${CLOTHED}, identical gallery pedestal. Both heads turn at the same angle under the same raking light.`
  },
  {
    id: '03-osiris-dioniso',
    act: 'I',
    left: 'Osíris', right: 'Dioniso',
    title: 'Osíris ⇄ Dioniso',
    claim: 'Heródoto igualou os dois: o deus egípcio que morre e renasce virou, na leitura grega, o deus do vinho e do êxtase.',
    source: 'Documento, §3: Herodotus equated Osiris→Dionysus.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: ancient Egyptian mummiform statue of Osiris in dark green schist, crook and flail crossed at the chest, atef crown, authentic Kemetic form, gallery pedestal. RIGHT HALF: ancient Greek marble statue of Dionysus, ivy crown, long draped robe covering the body, thyrsus staff held across the chest at the same crossed angle, aged marble, ${CLOTHED}, identical gallery pedestal.`
  },
  {
    id: '04-isis-demeter',
    act: 'I',
    left: 'Ísis', right: 'Deméter',
    title: 'Ísis ⇄ Deméter',
    claim: 'O culto de Ísis chegou à Itália por volta de 140 a.C., levado por comerciantes de Delos, e se espalhou por todo o império até ser desmontado pelo cristianismo de Estado.',
    source: 'Documento, §3: Isis cult reached Italy c. 140 BCE via Delos traders (Met/Karoglou); Edict of Thessalonica 380 CE; Serapeum destroyed 391 CE.',
    contested: false,
    note: 'A ligação Ísis lactans → Madona é DISPUTADA. Tran Tam Tinh (1973) argumenta contra a derivação direta pelo intervalo cronológico. Apresentar como debate aberto, nunca como fato.',
    prompt: `${LOOK} LEFT HALF: ancient Egyptian seated statue of Isis in dark stone, throne headdress, wearing a full-length carved sheath dress covering the whole body, hands resting on the knees, authentic Kemetic proportions, modest museum statuary, gallery pedestal. RIGHT HALF: ancient Greek marble seated statue of Demeter, veiled and fully draped in heavy robes, wheat sheaf in hand, hands resting on the knees at the identical angle, aged marble, identical gallery pedestal.`
  },

  // ─────────── ATO II, ÁFRICA ⇄ BRASIL (8) ───────────
  {
    id: '05-iansa-barbara',
    act: 'II',
    left: 'Iansã', right: 'Santa Bárbara',
    title: 'Iansã ⇄ Santa Bárbara',
    claim: 'A guerreira do vento e da tempestade escondida atrás de uma santa católica associada ao raio. Mãe Stella de Oxóssi desfez o nó em 1983: "sabemos que Iansã é outra energia; ela não é Santa Bárbara."',
    source: 'Documento, §1 e §2: Oyá/Iansã→St. Barbara; Jornal da Bahia, 29 jul 1983.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian woman embodying Oyá/Iansã, copper-red beaded garments, horsetail whisk raised, alive and breathing, warm terracotta light, dark background. RIGHT HALF: a colonial polychrome carved wooden statue of Saint Barbara on a church pedestal, chipped paint, gilded edges, holding a small tower, lit identically from the same side. Living body on one side, carved object on the other.`
  },
  {
    id: '06-xango-jeronimo',
    act: 'II',
    left: 'Xangô', right: 'São Jerônimo',
    title: 'Xangô ⇄ São Jerônimo',
    claim: 'Não existe mapa único. Na Bahia, Xangô foi pareado com São Jerônimo; em Cuba, Changó virou Santa Bárbara. O disfarce mudava conforme o lugar, porque nunca houve autoridade central, só sobrevivência local.',
    source: 'Documento, §1: Bahia Xangô→São Jerônimo (Univ. of Pittsburgh CLAS sheet); Cuba Changó→Santa Bárbara; "no central hierarchy to make the ascriptions".',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian man embodying Xangô, red and white beaded regalia, double-headed axe held upright, alive and powerful, warm terracotta light, dark background. RIGHT HALF: a colonial polychrome carved wooden statue of Saint Jerome on a church pedestal, red robe, aged cracked varnish, holding a book, lit identically from the same side.`
  },
  {
    id: '07-iemanja-conceicao',
    act: 'II',
    left: 'Iemanjá', right: 'N. Sra. da Conceição',
    title: 'Iemanjá ⇄ Nossa Senhora da Conceição',
    claim: 'A festa do Rio Vermelho, em Salvador, começou em 1923 com 25 pescadores. Hoje reúne mais de 300 mil pessoas, a maior festa afro-brasileira do país, feita à sombra de uma santa.',
    source: 'Documento, §1: Festa de Iemanjá, Rio Vermelho, begun 1923 by 25 fishermen, 300,000+ participants.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian woman embodying Iemanjá, white and silver beaded garments, seashell mirror in hand, ocean spray behind her, alive, cool night-blue light. RIGHT HALF: a colonial polychrome carved wooden statue of Our Lady of the Immaculate Conception on a church pedestal, blue and white robe, gilded stars, lit identically from the same side.`
  },
  {
    id: '08-ogum-jorge',
    act: 'II',
    left: 'Ogum', right: 'São Jorge',
    title: 'Ogum ⇄ São Jorge',
    claim: 'Ferro, guerra, estrada aberta. No Rio virou São Jorge a cavalo; na Bahia, Santo Antônio; em Cuba, São Pedro das chaves. O mesmo orixá, três máscaras diferentes.',
    source: 'Documento, §1: Ogum→St. George (Rio), St. Anthony (Bahia), St. Peter (Cuba), St. Michael (Trinidad).',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian man embodying Ogum, dark green and navy beaded regalia, iron sword and iron tools, alive, forge-lit, dark green shadow. RIGHT HALF: a colonial polychrome carved wooden statue of Saint George mounted on horseback, lance lowered, chipped gilding, on a church pedestal, lit identically from the same side.`
  },
  {
    id: '09-oxossi-sebastiao',
    act: 'II',
    left: 'Oxóssi', right: 'São Sebastião',
    title: 'Oxóssi ⇄ São Sebastião',
    claim: 'O caçador da mata, senhor do arco, pareado com o santo atravessado por flechas. A flecha que caça de um lado; a flecha que perfura do outro.',
    source: 'Documento, §1: Oxóssi/Ochosi→St. George or St. Sebastian (hunter/archer/forest).',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian man embodying Oxóssi, turquoise and green beaded regalia, drawing a ceremonial bow, dense forest shadow behind, alive, dappled green light. RIGHT HALF: a colonial polychrome carved wooden statue of Saint Sebastian bound to a tree stump pierced with arrows, aged paint, on a church pedestal, lit identically from the same side.`
  },
  {
    id: '10-omulu-lazaro',
    act: 'II',
    left: 'Omulu', right: 'São Lázaro',
    title: 'Omulu ⇄ São Lázaro',
    claim: 'Senhor da varíola, da doença e da cura, coberto de palha da costa. Virou São Lázaro, o santo das feridas. A doença dos escravizados precisava de um nome que os senhores aceitassem ouvir.',
    source: 'Documento, §1: Omulu/Obaluaiê/Babalú-Ayé→St. Lazarus and St. Roch; disease, smallpox, healing, sores.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a Black Brazilian figure embodying Omulu, entire head and body veiled in raffia straw fringe, no face visible, holding a ritual broom, alive and still, deep earth-brown light. RIGHT HALF: a colonial polychrome carved wooden statue of Saint Lazarus leaning on a crutch, wounds visible on the legs, two carved dogs at the feet, on a church pedestal, lit identically from the same side.`
  },
  {
    id: '11-oxala-bonfim',
    act: 'II',
    left: 'Oxalá', right: 'Senhor do Bonfim',
    title: 'Oxalá ⇄ Nosso Senhor do Bonfim',
    claim: 'É daí que vem o branco das sextas-feiras na Bahia. A roupa que a cidade inteira veste sem sempre saber que está vestindo um orixá.',
    source: 'Documento, §1: Oxalá→Nosso Senhor do Bonfim / Jesus Christ, "whence the Bahian custom of wearing white on Fridays"; opaxorô staff.',
    contested: false,
    prompt: `${LOOK} LEFT HALF: an elderly Black Brazilian man embodying Oxalá, entirely in white cloth and white beads, leaning on a tall silver ceremonial staff, alive, luminous bone-white light against black. RIGHT HALF: a colonial polychrome carved wooden crucifix figure of Senhor do Bonfim on a church pedestal, white cloth draped, aged gilding, lit identically from the same side.`
  },
  {
    id: '12-exu-demonizacao',
    act: 'II',
    left: 'Exu', right: 'A distorção',
    title: 'Exu ⇄ a mentira que colaram nele',
    claim: 'Exu abre caminho, entrega o recado, guarda a encruzilhada. Foi pareado com Santo Antônio e com o Menino de Atocha, mas quem estava de fora o transformou no Diabo. É a distorção que os praticantes rejeitam até hoje.',
    source: 'Documento, §1: Exu/Eleguá→St. Anthony of Padua, Holy Child of Atocha, St. Michael; "demonized and conflated with the Devil by outsiders, a distortion practitioners reject."',
    contested: false,
    prompt: `${LOOK} LEFT HALF: a dignified Black Brazilian man in a formal black and red suit with a wide brimmed black hat and beaded necklaces, fully clothed, standing at a dirt crossroads at dusk, holding a carved wooden walking staff, calm and commanding, warm red-earth light, dark background. RIGHT HALF: an antique European copper engraving printing plate photographed as a museum artifact on a gallery pedestal, tarnished cold grey metal, deeply scratched cracked and worn surface, its etched lines illegible and abraded, lit identically from the same side. The contrast is between a dignified living man and a damaged old foreign printing plate.`
  }
];

export const CLOSING = {
  who: 'Mãe Stella de Oxóssi (Maria Stella de Azevedo Santos, 1925–2018), iyalorixá do Ilê Axé Opô Afonjá',
  when: 'II Conferência Mundial da Tradição dos Orixás e Cultura, Salvador, 17–23 de julho de 1983',
  quote: 'ficou claro ser nossa crença uma religião e não uma seita sincretizada',
  quote2: 'rejeitamos o sincretismo como fruto da nossa religião, já que ele foi criado pela escravidão a que nossos ancestrais foram submetidos',
  cosigners: 'Mãe Menininha do Gantois e Mãe Olga de Alaketu confirmadas como signatárias; Mãe Tetê de Iansã e Mãe Nicinha do Bogum citadas em fonte única (a verificar).',
  source: 'Documento, §2, manifesto em duas versões (27 jul e 12 ago 1983), "Ao público e ao povo de Candomblé".'
};
