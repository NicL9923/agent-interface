// Original line icons on a 24-unit grid. Decorative: the control supplies the name.

function polygon(points: number, outer: number, inner: number, rotate = -Math.PI / 2) {
  return (
    Array.from({ length: points * 2 }, (_, i) => {
      const radius = i % 2 ? inner : outer;
      const angle = rotate + (Math.PI * i) / points;
      return `${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`;
    }).reduce((d, point, i) => d + (i ? " L" : "M") + point, "") + "Z"
  );
}
function gear() {
  const teeth = 8;
  let d = "";
  for (let i = 0; i < teeth; i++) {
    const a = (Math.PI * 2 * i) / teeth;
    const w = 0.2;
    const point = (r: number, angle: number) =>
      `${(12 + r * Math.cos(angle)).toFixed(2)} ${(12 + r * Math.sin(angle)).toFixed(2)}`;
    d += `${i ? " L" : "M"}${point(7.2, a - 0.39)} L${point(9.4, a - w)} L${point(9.4, a + w)} L${point(7.2, a + 0.39)}`;
  }
  return d + "Z";
}

const paths = {
  today: "M5 5h14v15H5ZM8 3v4M16 3v4M5 10h14M8 14h2M14 14h2M8 17h2",
  menu: "M4 7h16M4 12h16M4 17h16",
  computer: "M4 4h16v12H4ZM9 20h6M12 16v4",
  terminal: "M5 7l5 5-5 5M13 17h6",
  close: "M6 6l12 12M18 6L6 18",
  gear: gear() + "M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0Z",
  star: polygon(5, 9, 4.1),
  plus: "M12 5v14M5 12h14",
  attach: "M19.5 11.5l-7.1 7.1a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3.1 3.1 0 0 1 4.4 4.4l-7.2 7.2a1.5 1.5 0 0 1-2.2-2.2l6.6-6.6",
  send: "M12 19V5M6 11l6-6 6 6",
  stop: "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z",
  sliders: "M4 7h9M18 7h2M4 17h3M12 17h8M15.5 4.5v5M9.5 14.5v5",
  plug: "M9 3v4M15 3v4M6.5 7h11v4a5.5 5.5 0 0 1-11 0ZM12 16.5V21",
  chevron: "M9.5 6l6 6-6 6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  external: "M13 5h6v6M19 5l-8 8M17 14v5H5V7h5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  undo: "M9 15L4 10l5-5M4 10h10a5.5 5.5 0 0 1 0 11h-3",
  upgrade: "M12 17V7M7.5 11.5L12 7l4.5 4.5M5 20h14",
  file: "M7 3h7l5 5v13H7ZM14 3v5h5",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z",
  search: "M16.5 10.5a6 6 0 1 1-12 0a6 6 0 1 1 12 0ZM15 15l5 5",
  groups: "M4 5h11v8H9l-3 3v-3H4ZM15 9h5v8h-2v3l-3-3h-4v-4",
  mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
  model: "M8 8h8v8H8ZM10 4v4M14 4v4M10 16v4M14 16v4M4 10h4M4 14h4M16 10h4M16 14h4",
  speaker: "M4 9.5h4L13 5v14l-5-4.5H4ZM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11",
} as const;
export type IconName = keyof typeof paths;
const filledIcons: IconName[] = ["stop"];

export function Icon({ name, size = 20, filled = false, className }: {
  name: IconName;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  const fill = filled || filledIcons.includes(name);
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
