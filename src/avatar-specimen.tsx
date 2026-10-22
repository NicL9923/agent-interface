import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  avatarColors,
  avatarStates,
  defaultAvatar,
  stateLabels,
} from "./components/Avatar";
import { everydayFamilies, type ActivityState, type Avatar as AvatarConfig, type MascotFamily } from "./shared/types";
import "./avatar-specimen.css";
import { seasonalAvatar, seasonalChoices } from "./components/character-avatars";
const everydayColors: Record<(typeof everydayFamilies)[number], string> = {
  bear: "#FF9800",
  fox: "#FF6700",
  sprout: "#00BCA6",
  panda: "#292929",
  raccoon: "#8C8F99",
  owl: "#97683D",
  cactus: "#00BCA6",
  dinosaur: "#9159FE",
};
const everyday = (family: MascotFamily & keyof typeof everydayColors): Extract<AvatarConfig, { mode: "mascot" }> =>
  ({ mode: "mascot", family, color: everydayColors[family], eyes: "oval", accessory: "none" });
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
  ["Bear", { ...everyday("bear"), eyes: "round" }],
  ["Fox", everyday("fox")],
  ["Sprout", { ...everyday("sprout"), accessory: "hat" }],
  ...everydayFamilies.slice(3).map((family): [string, AvatarConfig] => [family[0].toUpperCase() + family.slice(1), everyday(family)]),
  ["Portrait", { mode: "portrait", src: portrait, origin: "uploaded" }],
  ...seasonalChoices.map(({ family, label }): [string, AvatarConfig] => [label, seasonalAvatar(family)]),
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
          Original shapes and motion, compared against the Grok lifecycle
          reference. Mascots are a bounded family; portraits stay still.
        </p>
      </header>
      <div className="spec-controls">
        <button onClick={() => setDark(!dark)}>
          {dark ? "Light" : "Dark"} theme
        </button>
        <label>
          <input
            type="checkbox"
            checked={reduce}
            onChange={(e) => setReduce(e.target.checked)}
          />{" "}
          Reduce motion
        </label>
      </div>
      <section className="spec-preview">
        <Avatar
          avatar={avatar}
          state={state}
          size={160}
          reducedMotion={reduce}
        />
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
            <button
              key={s}
              aria-pressed={s === state}
              onClick={() => setState(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2>Geometric identity</h2>
        <p>
          The eight silhouettes and palette observed in the reference. Shape and
          eye controls below are our own UI.
        </p>
        <div className="spec-shapes">
          {(
            [
              "blob",
              "pebble",
              "squircle",
              "capsule",
              "triangle",
              "hex",
              "cloud",
              "drop",
            ] as const
          ).map((shape, i) => (
            <button
              key={shape}
              onClick={() =>
                setAvatar({ ...defaultAvatar, shape, color: avatarColors[i] })
              }
            >
              <Avatar
                avatar={{ ...defaultAvatar, shape, color: avatarColors[i] }}
                size={70}
                state={state}
                reducedMotion={reduce}
              />
              <span>{shape}</span>
            </button>
          ))}
        </div>
        <div className="spec-controls">
          <label>
            Eyes{" "}
            <select
              onChange={(e) => {
                if (avatar.mode !== "portrait")
                  setAvatar({
                    ...avatar,
                    eyes: e.target.value as
                      "round" | "oval" | "visor" | "spark",
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
                if (avatar.mode !== "portrait")
                  setAvatar({ ...avatar, color: c });
              }}
            />
          ))}
        </div>
      </section>
      <section>
        <h2>Mascot family</h2>
        <p>
          Soft, rounded companions with expressive eyes and controlled
          customization. Original vector artwork, inspired by Muse's personal
          character approach.
        </p>
        <div className="spec-shapes">
          {everydayFamilies.map((family) => (
            <button key={family} onClick={() => setAvatar(everyday(family))}>
              <Avatar avatar={everyday(family)} size={90} state={state} reducedMotion={reduce} />
              <span>{family}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2>Seasonal characters</h2>
        <p>Original holiday companions with the same working, thinking and reduced-motion behavior.</p>
        <div className="spec-shapes">
          {seasonalChoices.map(({ family, label }) => <button key={family} onClick={() => setAvatar(seasonalAvatar(family))}>
            <Avatar avatar={seasonalAvatar(family)} size={90} state={state} reducedMotion={reduce} />
            <span>{label}</span>
          </button>)}
        </div>
      </section>
      <section>
        <h2>Static portrait</h2>
        <p>
          Uploaded and generated images use a separate state treatment. A
          portrait never pretends to animate.
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
                    src: String(r.result),
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
          Every mode in every state. Thinking and blocked morph into symbols;
          portraits use a ring and badge instead of a face.
        </p>
        <div className="spec-matrix" role="table" aria-label="Avatar state matrix">
          <div role="row">
            <span role="columnheader" />
            {avatarStates.map((s) => (
              <span role="columnheader" key={s}>{stateLabels[s]}</span>
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
              <Avatar
                avatar={avatar}
                state={s}
                size={42}
                reducedMotion={reduce}
              />
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
