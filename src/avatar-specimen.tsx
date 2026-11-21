import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  avatarColors,
  avatarStates,
  defaultAvatar,
  stateLabels,
} from "./components/Avatar";
import {
  avatarShapeGroups,
  avatarShapes,
  type ActivityState,
  type Avatar as AvatarConfig,
  type AvatarShape,
} from "./shared/types";
import "./avatar-specimen.css";
import { seasonalColors, shapeGroups, shapeLabel } from "./components/avatar-shapes";
/** The color each object and creature is shown in here. In the app a shape takes the color already chosen. */
const showcase: Partial<Record<AvatarShape, string>> = {
  cloud: "#00BCA6",
  star: "#FF6700",
  egg: "#F4F4F4",
  shield: "#1084FE",
  chat: "#9159FE",
  lightbulb: "#FF9800",
  mug: "#F4F4F4",
  book: "#97683D",
  camera: "#7A7A7A",
  magnifier: "#1084FE",
  controller: "#FF6700",
  barbell: "#FF263C",
  brain: "#FF309B",
  rocket: "#7A7A7A",
  palette: "#97683D",
  "paint-brush": "#1FBF68",
  "watering-can": "#00BCA6",
  sprout: "#1FBF68",
  cactus: "#1FBF68",
  "witch-hat": "#9159FE",
  ghost: "#F4F4F4",
  cat: "#FF9800",
  bunny: "#FF309B",
  bull: "#FF263C",
  bear: "#97683D",
  fox: "#FF6700",
  owl: "#9159FE",
  dino: "#1FBF68",
  tars: "#7A7A7A",
  rocky: "#97683D",
  ...seasonalColors,
};
const shown = (shape: AvatarShape): Extract<AvatarConfig, { mode: "geometric" }> => ({
  ...defaultAvatar,
  shape,
  color: showcase[shape] ?? avatarColors[avatarShapes.indexOf(shape) % avatarColors.length],
});
const portrait =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#d9c7a3"/><circle cx="40" cy="31" r="15" fill="#6b4f3a"/><path d="M12 80c4-20 16-29 28-29s24 9 28 29Z" fill="#3f6b57"/></svg>',
  );
const matrix: [string, AvatarConfig][] = [
  ["Blob", defaultAvatar],
  ["Triangle", { ...defaultAvatar, shape: "triangle", color: "#FF309B", eyes: "visor" }],
  ["Drop", { ...defaultAvatar, shape: "drop", color: "#97683D", accessory: "hat" }],
  ["Hex", { ...defaultAvatar, shape: "hex", color: "#9159FE", accessory: "glasses" }],
  ["Sprout", shown("sprout")],
  ["Mug", { ...shown("mug"), eyes: "round" }],
  ["Ghost", shown("ghost")],
  ["Cactus", { ...shown("cactus"), accessory: "hat" }],
  ["Dino", shown("dino")],
  ["TARS", shown("tars")],
  ["Rocky", { ...shown("rocky"), accessory: "glasses" }],
  ["Pumpkin", shown("pumpkin")],
  ["Portrait", { mode: "portrait", src: portrait, origin: "uploaded" }],
];
function Specimen() {
  const [state, setState] = useState<ActivityState>("idle");
  const [avatar, setAvatar] = useState<AvatarConfig>(defaultAvatar);
  const [reduce, setReduce] = useState(false);
  const [dark, setDark] = useState(false);
  return (
    <main data-theme={dark ? "dark" : "light"}>
      <header>
        <p>WildBots · standalone specimen</p>
        <h1>
          A familiar face.
          <br />
          An honest state.
        </h1>
        <p>
          One flat silhouette with two eyes for every drawn avatar, in the app's own motion rig.
          Portraits stay still.
        </p>
      </header>
      <div className="spec-controls">
        <button onClick={() => setDark(!dark)}>{dark ? "Light" : "Dark"} theme</button>
        <label>
          <input type="checkbox" checked={reduce} onChange={(e) => setReduce(e.target.checked)} />{" "}
          Reduce motion
        </label>
      </div>
      <section className="spec-preview">
        <Avatar avatar={avatar} state={state} size={160} reducedMotion={reduce} />
        <h2>{stateLabels[state]}</h2>
        <p>
          {state === "disconnected"
            ? "Activity is unknown. Movement stops."
            : state === "interrupted"
              ? "Review the interrupted task before retrying."
              : "Choose a state to inspect its expression and transition."}
        </p>
        <div className="spec-states">
          {avatarStates.map((s) => (
            <button key={s} aria-pressed={s === state} onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2>Every shape</h2>
        <p>
          The picker's four groups. Objects and creatures follow the Open Bot Avatar format: one
          silhouette, with the face on its largest part.
        </p>
        {shapeGroups.map((group) => (
          <div key={group.id}>
            <h3>{group.label}</h3>
            <div className="spec-shapes">
              {avatarShapeGroups[group.id].map((shape: AvatarShape) => (
                <button key={shape} onClick={() => setAvatar(shown(shape))}>
                  <Avatar avatar={shown(shape)} size={70} state={state} reducedMotion={reduce} />
                  <span>{shapeLabel(shape)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="spec-controls">
          <label>
            Eyes{" "}
            <select
              onChange={(e) => {
                if (avatar.mode !== "portrait")
                  setAvatar({
                    ...avatar,
                    eyes: e.target.value as "round" | "oval" | "visor" | "spark",
                  });
              }}
            >
              {["oval", "round", "visor", "spark"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Accessory{" "}
            <select
              onChange={(e) => {
                if (avatar.mode !== "portrait")
                  setAvatar({
                    ...avatar,
                    accessory: e.target.value as "none" | "hat" | "glasses",
                  });
              }}
            >
              {["none", "hat", "glasses"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          {avatarColors.map((c) => (
            <button
              key={c}
              aria-label={`Color ${c}`}
              className="spec-swatch"
              style={{ background: c }}
              onClick={() => {
                if (avatar.mode !== "portrait") setAvatar({ ...avatar, color: c });
              }}
            />
          ))}
        </div>
      </section>
      <section>
        <h2>Accessories and eyes on every shape</h2>
        <p>
          A hat sits on the part that carries the face, and glasses and every eye style stay on it.
        </p>
        {(
          [
            ["Cowboy hat", { accessory: "hat" }],
            ["Glasses", { accessory: "glasses" }],
            ["Visor eyes", { eyes: "visor" }],
            ["Happy, at sidebar size", {}],
          ] as const
        ).map(([label, patch]) => (
          <div key={label}>
            <h3>{label}</h3>
            <div className="spec-wall" data-wall={label}>
              {avatarShapes.map((shape) => (
                <Avatar
                  key={shape}
                  avatar={{ ...shown(shape), ...patch }}
                  size={label.startsWith("Happy") ? 28 : 56}
                  state={label.startsWith("Happy") ? "done" : "idle"}
                  reducedMotion
                  name={shapeLabel(shape)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
      <section>
        <h2>Static portrait</h2>
        <p>
          Uploaded and generated images use a separate state treatment. A portrait never pretends to
          animate.
        </p>
        <label>
          Choose a portrait{" "}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const r = new FileReader();
                r.onload = () =>
                  setAvatar({
                    mode: "portrait",
                    src: typeof r.result === "string" ? r.result : "",
                    origin: "uploaded",
                  });
                r.readAsDataURL(f);
              }
            }}
          />
        </label>
      </section>
      <section>
        <h2>State matrix</h2>
        <p>
          Both styles in every state. Blocked morphs into a symbol; portraits use a ring and badge
          instead of a face.
        </p>
        <div className="spec-matrix" role="table" aria-label="Avatar state matrix">
          <div role="row">
            <span role="columnheader" />
            {avatarStates.map((s) => (
              <span role="columnheader" key={s}>
                {stateLabels[s]}
              </span>
            ))}
          </div>
          {matrix.map(([label, config]) => (
            <div role="row" key={label}>
              <span role="rowheader">{label}</span>
              {avatarStates.map((s) => (
                <span role="cell" key={s}>
                  <Avatar avatar={config} state={s} size={64} reducedMotion={reduce} name={label} />
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>All states at sidebar size</h2>
        <div className="spec-states-grid">
          {avatarStates.map((s) => (
            <div key={s}>
              <Avatar avatar={avatar} state={s} size={42} reducedMotion={reduce} />
              <span>{stateLabels[s]}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Specimen />
  </React.StrictMode>,
);
