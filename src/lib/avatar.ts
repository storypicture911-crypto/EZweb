export interface AvatarGroup { category: string; items: readonly (readonly [string, string])[] }
export const avatarCatalog: readonly AvatarGroup[] = [
  { category: "Animals", items: [["cat-01","🐱"],["panda-03","🐼"],["fox-02","🦊"]] },
  { category: "Cars", items: [["car-01","🚙"],["sports-car-02","🏎️"],["supercar-05","🚗"]] },
  { category: "Motorbikes", items: [["motorbike-01","🏍️"],["scooter-02","🛵"]] },
  { category: "Characters", items: [["male-04","👨"],["female-08","👩"],["cartoon-11","🧚"]] },
  { category: "Robots & Gaming", items: [["robot-03","🤖"],["gaming-01","🎮"],["space-02","🚀"]] },
  { category: "Nature & Lucky", items: [["lucky-clover-01","🍀"],["moon-02","🌙"],["flower-03","🌸"]] },
  { category: "Fantasy & Food", items: [["wizard-01","🧙"],["dragon-02","🐉"],["food-01","🍜"]] },
] as const;

const avatarMap = new Map<string, string>(avatarCatalog.flatMap((group) => [...group.items]));
export const avatarEmoji = (key?: string | null): string => avatarMap.get(key || "") || "🍀";
