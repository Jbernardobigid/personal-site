/**
 * 9:16 stacked-diptych specs for the Odisseia Reel.
 *
 * Vertical, not the report's landscape: the seam runs HORIZONTALLY so the whole
 * comparison survives a phone frame. Landscape panels lose ~55% of their width
 * to a 1080x1920 crop, which destroys the pairing that carries the argument.
 *
 * Filter lessons carried over from the report run (all three cost a retry there):
 *  - classical statuary is rejected as safety_violations=[sexual] unless full
 *    drapery is stated explicitly, so CLOTHED is appended to every Greek figure;
 *  - naming an orixá trips the filter, so figures are described, never named;
 *  - no real person may be depicted (Nyong'o, Damon et al are off-limits).
 */

const LOOK = 'Vertical 9:16 portrait composition, split into a TOP half and a BOTTOM half by a single thin horizontal seam. '
  + 'Both halves share identical lighting, identical camera height and identical scale. '
  + 'Museum object photography: raking side light, deep shadow falloff, matte surfaces, fine dust suspended in the air. '
  + 'Color grade restricted to terracotta brown, deep night blue, dark green, black and warm bone grey. '
  + 'Absolutely no text, no letters, no numerals, no signage, no watermark anywhere in the image.';

const CLOTHED = 'The figure is fully clothed in heavy carved drapery covering torso and legs, modest museum statuary.';

export const PANELS = [
  {
    id: '01-helena',
    beat: 1,
    concept: 'Same woman, two materials. The fight is over who is allowed to be her.',
    prompt: `${LOOK} TOP HALF: a classical Greek marble bust of an anonymous noblewoman, pale weathered marble, hair bound in a fillet, lit by cold museum light on a gallery pedestal. ${CLOTHED} BOTTOM HALF: the identical bust of the same anonymous woman carved instead in dark polished basalt, same pose, same angle, same features, lit by warm terracotta light on an identical pedestal. Not a real person, an invented classical sculpture.`
  },
  {
    id: '02-bracos',
    beat: 2,
    concept: 'The epithet meant status, not skin: the arm that never worked vs the arm that did.',
    prompt: `${LOOK} TOP HALF: an extreme close-up of a carved marble forearm and hand at rest, palm open and unmarked, a fine gold bracelet at the wrist, smooth polished stone, cold soft light. BOTTOM HALF: an extreme close-up of a carved stone forearm and hand of a labourer gripping a coarse rope, tendons raised, surface weathered and pitted, warm hard light. Same arm position, same framing, same scale in both halves. Sculpture only, no full figure.`
  },
  {
    id: '03-herodoto',
    beat: 3,
    concept: 'The Greek who wrote it down, and the Egyptian source he was writing about.',
    prompt: `${LOOK} TOP HALF: a classical Greek marble portrait bust of a bearded ancient historian in strict profile facing right, weathered marble, gallery pedestal. ${CLOTHED} BOTTOM HALF: an ancient Egyptian seated scribe statue in dark stone, also in strict profile facing right, papyrus roll across the lap, authentic Kemetic proportions, identical pedestal and identical raking light.`
  },
  {
    id: '04-thoth-hermes',
    beat: 4,
    concept: 'Same tablet, same stylus. The proof panel.',
    prompt: `${LOOK} TOP HALF: an ancient Egyptian basalt statue of an ibis-headed deity holding a scribe palette and a reed stylus, dark polished stone, authentic Kemetic regalia, gallery pedestal. BOTTOM HALF: an ancient Greek bronze statue of a young male god wearing a long draped chlamys cloak and winged sandals, holding an identical writing tablet and identical stylus in the identical gesture, patinated bronze, ${CLOTHED} identical gallery pedestal.`
  },
  {
    id: '05-amon-zeus',
    beat: 5,
    concept: 'The horns are the borrowed thing. Put them side by side and it is undeniable.',
    prompt: `${LOOK} TOP HALF: a monumental ancient Egyptian granite head of a ram-horned deity, curling ram horns spiralling at the temples, dark granite, authentic Kemetic carving, gallery pedestal. BOTTOM HALF: a monumental ancient Greek marble head of a bearded sky god, the same curling ram horns spiralling at his temples, weathered marble, identical head angle, identical pedestal, identical raking light. The horns are visually identical in both halves.`
  },
  {
    id: '06-fecho',
    beat: 6,
    concept: 'Egyptian in front, Greek receding behind. Empty lower third reserved for the CTA text.',
    prompt: `Vertical 9:16 portrait composition, single unified scene, no split and no seam. An ancient Egyptian dark stone statue stands in sharp focus in the upper portion of the frame, and behind it, receding into deep shadow and soft focus, a pale Greek marble statue of similar height. Museum raking side light, fine dust in the air, matte surfaces. Colour grade restricted to terracotta brown, deep night blue, black and warm bone grey. Both figures fully clothed in heavy carved drapery, modest museum statuary. The entire lower third of the frame is empty darkness with no objects in it. Absolutely no text, no letters, no numerals, no watermark anywhere.`
  }
];
