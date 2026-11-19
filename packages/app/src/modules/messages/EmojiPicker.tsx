/**
 * Curated emoji picker (MVP: ~240 frequently used, searchable) + full
 * shortcode table used by the composer pipeline. No dependencies.
 */
import { useMemo, useRef, useState } from "react";
import { useClickAway } from "../a11y.js";

const GROUPS: { label: string; emojis: [string, string][] }[] = [
  {
    label: "Smileys",
    emojis: [
      ["😀", "grinning happy face"], ["😃", "smiley happy"], ["😄", "smile happy tongue"], ["😁", "grin beams"],
      ["😆", "laughing satisfied"], ["😅", "sweat smile relief"], ["🤣", "rofl rolling laughing"], ["😂", "joy laugh tears"],
      ["🙂", "slight smile"], ["🙃", "upside down"], ["😉", "wink"], ["😊", "blush smile"],
      ["😇", "halo innocent angel"], ["🥰", "hearts love adore"], ["😍", "heart eyes love"], ["🤩", "star struck"],
      ["😘", "kiss heart blow"], ["😗", "kiss"], ["😚", "kiss closed eyes"], ["😙", "kiss smile"],
      ["🥲", "tear smile"], ["😋", "yum tongue food"], ["😛", "tongue"], ["😜", "tongue wink crazy"],
      ["🤪", "zany"], ["😝", "tongue squint"], ["🤑", "money mouth"], ["🤗", "hug hands"],
      ["🤭", "hand over mouth giggle"], ["🤫", "shush quiet"], ["🤔", "thinking hmm"], ["🤐", "zipper mouth"],
      ["😐", "neutral"], ["😑", "expressionless"], ["😶", "no mouth"], ["😏", "smirk"],
      ["😒", "unamused"], ["🙄", "eyes roll"], ["😬", "grimace"], ["🤥", "liar pinocchio"],
      ["😌", "relief calm"], ["😔", "pensive sad"], ["😪", "sleepy tired"], ["🤤", "drool"],
      ["😴", "sleep zzz"], ["😷", "mask sick"], ["🤒", "thermometer fever"], ["🤕", "bandage hurt"],
      ["🤢", "nausea sick"], ["🤮", "vomit"], ["🥴", "woozy drunk"], ["😵", "dizzy"],
      ["🤯", "mind blown exploding head"], ["🥳", "party hat celebration"], ["😎", "sunglasses cool"], ["🤓", "nerd glasses"],
      ["🧐", "monocle"], ["😕", "confused"], ["😟", "worried"], ["🙁", "frown slight"],
      ["😮", "open surprised"], ["😯", "hushed"], ["😲", "astonished"], ["😳", "flushed"],
      ["🥺", "pleading puppy eyes"], ["😦", "frown open"], ["😧", "anguish"], ["😨", "fear scared"],
      ["😰", "sweat cold anxious"], ["😥", "sad relieved"], ["😢", "cry tear"], ["😭", "sob cry big"],
      ["😱", "scream shock"], ["😖", "confounded"], ["😣", "persevere"], ["😞", "disappointed"],
      ["😓", "sweat down"], ["😩", "weary tired"], ["😫", "tired"], ["🥱", "yawn"],
      ["😤", "triumph steam"], ["😡", "rage angry red"], ["😠", "mad angry"], ["🤬", "cursing swear"],
      ["😈", "devil smile"], ["👿", "imp"], ["💀", "skull dead"], ["☠️", "crossbones skull"],
    ],
  },
  {
    label: "Gestures & People",
    emojis: [
      ["👋", "wave hand hello bye"], ["🤚", "raised hand back"], ["✋", "hand raised stop high five"], ["🖖", "vulcan spock"],
      ["👌", "ok perfect"], ["🤌", "pinched italian"], ["✌️", "victory peace"], ["🤞", "fingers crossed luck"],
      ["🫰", "finger heart money snap"], ["🤟", "love you sign"], ["👍", "thumbs up yes like +1"], ["👎", "thumbs down no -1"],
      ["✊", "fist punch raised"], ["👊", "fist bump punch"], ["🤛", "fist left bump"], ["🤜", "fist right bump"],
      ["👏", "clap hands"], ["🙌", "hands raised praise celebrate"], ["🫶", "heart hands love"], ["👐", "open hands"],
      ["🤲", "palms up prayer"], ["🙏", "pray thanks please"], ["💪", "muscle flex strong"], ["🦾", "mechanical arm"],
      ["✍️", "writing hand"], ["💅", "nail polish"], ["👀", "eyes look watch"], ["👁️", "eye"],
      ["🧠", "brain smart"], ["👅", "tongue"], ["👃", "nose"], ["👂", "ear"],
    ],
  },
  {
    label: "Hearts & Symbols",
    emojis: [
      ["❤️", "heart red love"], ["🧡", "heart orange"], ["💛", "heart yellow"], ["💚", "heart green"],
      ["💙", "heart blue"], ["💜", "heart purple"], ["🖤", "heart black"], ["🤍", "heart white"],
      ["🤎", "heart brown"], ["💔", "heartbreak broken"], ["❤️‍🔥", "heart fire"], ["❤️‍🩹", "heart mending heal"],
      ["❣️", "heart exclamation"], ["💕", "hearts two love"], ["💞", "hearts revolving"], ["💓", "heartbeat beating"],
      ["💗", "heart growing"], ["💖", "heart sparkling"], ["💘", "heart arrow cupid"], ["💝", "heart gift"],
      ["☮️", "peace"], ["✝️", "cross"], ["☪️", "islam star"], ["🕉️", "om"],
      ["☸️", "dharma wheel"], ["✡️", "judaism star david"], ["🔯", "star of david"], ["🕎", "menorah"],
      ["☯️", "yin yang"], ["⚛️", "atom"], ["🉐", "ideograph bargain"], ["🈹", "discount"],
      ["✳️", "asterisk eight"], ["❇️", "sparkle"], ["‼️", "exclamation double"], ["⁉️", "exclamation question"],
      ["❓", "question"], ["❔", "question white"], ["❗", "exclamation red"], ["❕", "exclamation white"],
      ["💯", "hundred perfect"], ["🔅", "dim"], ["🔆", "bright"], ["⚠️", "warning caution"],
      ["🚸", "children crossing"], ["♻️", "recycle"], ["✅", "check mark done"], ["☑️", "check box"],
      ["✔️", "check"], ["❌", "cross no x"], ["⭕", "circle o"], ["🚫", "prohibited no"],
      ["🔞", "18 not"], ["📵", "no phones"], ["➕", "plus add"], ["➖", "minus"],
      ["➗", "divide"], ["✖️", "multiply x"], ["♾️", "infinity"], ["🔱", "trident"],
    ],
  },
  {
    label: "Objects & Nature",
    emojis: [
      ["🔥", "fire hot lit flame"], ["⭐", "star"], ["🌟", "star glowing shine"], ["✨", "sparkles stars"],
      ["⚡", "lightning bolt zap"], ["☄️", "comet"], ["💥", "boom collision explosion"], ["🌈", "rainbow"],
      ["☀️", "sun sunny"], ["🌤️", "sun cloud"], ["⛅", "cloud sun"], ["🌧️", "rain cloud"],
      ["⛈️", "storm thunder"], ["🌩️", "lightning cloud"], ["❄️", "snowflake cold"], ["🌨️", "snow cloud"],
      ["☃️", "snowman"], ["🌊", "wave water sea"], ["💧", "drop water"], ["💦", "sweat splashes"],
      ["🎉", "party tada celebrate"], ["🎊", "ball confetti"], ["🎈", "balloon"], ["🎁", "gift present box"],
      ["🏆", "trophy win"], ["🥇", "medal first gold"], ["🎯", "dart bullseye target"], ["🎮", "game controller"],
      ["🕹️", "joystick"], ["🎲", "dice game"], ["♟️", "chess"], ["🧩", "puzzle"],
      ["🚀", "rocket ship launch"], ["🛸", "ufo"], ["✈️", "plane flight"], ["🚗", "car"],
      ["🚌", "bus"], ["🚲", "bike bicycle"], ["⚓", "anchor"], ["🛰️", "satellite"],
      ["💡", "idea light bulb"], ["🔍", "search magnifying"], ["🔎", "search zoom"], ["🔔", "bell notification"],
      ["📌", "pin"], ["📎", "clip paper"], ["📈", "chart up growth"], ["📉", "chart down"],
      ["💰", "money bag"], ["💳", "card credit"], ["🎵", "note music"], ["🎶", "notes music"],
      ["🎤", "mic karaoke"], ["🎧", "headphones"], ["📷", "camera"], ["💻", "laptop computer"],
      ["⌚", "watch"], ["📱", "phone mobile"], ["☕", "coffee tea drink"], ["🍺", "beer"],
      ["🍻", "beers cheers"], ["🍕", "pizza"], ["🍔", "burger"], ["🌮", "taco"],
      ["🍜", "ramen noodles"], ["🍰", "cake"], ["🎂", "birthday cake"], ["🍎", "apple"],
      ["🍌", "banana"], ["🍇", "grapes"], ["🥑", "avocado"], ["🌶️", "chili spicy hot"],
      ["🐛", "bug"], ["🦋", "butterfly"], ["🐝", "bee"], ["🐌", "snail"],
      ["🦠", "microbe virus"], ["🌱", "seedling grow"], ["🌲", "tree"], ["🌸", "blossom flower"],
      ["🌻", "sunflower"], ["🍀", "clover luck four leaf"], ["💎", "gem diamond"], ["🔑", "key"],
    ],
  },
  {
    label: "Faces Misc",
    emojis: [
      ["🤖", "robot bot"], ["👽", "alien"], ["👻", "ghost boo"], ["💩", "poo hankey"],
      ["😈", "devil"], ["🤡", "clown"], ["🫥", "dotted face invisible"], ["🥸", "disguised glasses"],
      ["🤠", "cowboy"], ["🫠", "melting"], ["🥲", "smiling tear"], ["😴", "sleep"],
      ["🤮", "sick"], ["🥵", "hot"], ["🥶", "cold freezing"], ["😵‍💫", "spiral dizzy"],
      ["🫣", "peek"], ["🫡", "salute"], ["🤥", "pinocchio"], ["😬", "yikes grimace"],
      ["🙈", "see no evil"], ["🙉", "hear no evil"], ["🙊", "speak no evil"], ["💋", "lipstick kiss"],
      ["🩷", "heart pink"], ["🫙", "jar"], ["🗿", "moai"], ["🎃", "pumpkin halloween"],
    ],
  },
];

export const EMOJI_FLAT: { char: string; name: string; group: string }[] = GROUPS.flatMap((g) =>
  g.emojis.map(([char, name]) => ({ char, name, group: g.label })),
);

export function EmojiPicker({
  onSelect,
  onClose,
  label,
}: {
  onSelect: (char: string) => void;
  onClose: () => void;
  label: string;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  // W12 item 2: pointerdown outside closes; Escape too (not a modal, no
  // useModalA11y here)
  useClickAway(ref, onClose, true);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS.map((g) => ({ label: g.label, items: g.emojis.map(([c, n]) => ({ c, n })) }));
    const hits = EMOJI_FLAT.filter((e) => e.name.includes(q) || e.char === q);
    const byGroup = new Map<string, { c: string; n: string }[]>();
    for (const h of hits) {
      const list = byGroup.get(h.group) ?? [];
      list.push({ c: h.char, n: h.name });
      byGroup.set(h.group, list);
    }
    return [...byGroup.entries()].map(([label2, items]) => ({ label: label2, items }));
  }, [query]);

  return (
    <div className="emoji-picker" role="dialog" aria-label={label} ref={ref} data-testid={label}>
      <input
        autoFocus
        aria-label="Search emoji"
        placeholder="Search emoji…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="emoji-grid">
        {results.map((g) => (
          <div key={g.label} className="emoji-cat">
            <h4>{g.label}</h4>
            <div className="emoji-row">
              {g.items.map((e, i) => (
                <button
                  key={`${e.c}${i}`}
                  title={e.n}
                  aria-label={e.n}
                  onClick={() => {
                    onSelect(e.c);
                    onClose();
                  }}
                >
                  {e.c}
                </button>
              ))}
            </div>
          </div>
        ))}
        {results.length === 0 && <p className="placeholder">No matches.</p>}
      </div>
    </div>
  );
}
