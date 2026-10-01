import { useId, useRef, useState, type ReactNode } from "react";
import type { Accessory, ActivityState, Avatar as AvatarConfig, Eyes } from "../shared/types";
import { Avatar, avatarColors, defaultAvatar, stateLabels } from "./Avatar";
import "./avatar-editor.css";

type DrawnAvatar = Exclude<AvatarConfig, { mode: "portrait" }>;
type Shape = Extract<AvatarConfig, { mode: "geometric" }>["shape"];
type Family = Extract<AvatarConfig, { mode: "mascot" }>["family"];

const shapes: Shape[] = ["blob", "pebble", "squircle", "capsule", "triangle", "hex", "cloud", "drop", "circle"];
const families: Family[] = ["bear", "fox", "sprout"];
const eyeStyles: Eyes[] = ["oval", "round", "visor", "spark"];
const accessories: Accessory[] = ["none", "hat", "glasses"];
const previewStates: ActivityState[] = ["idle", "thinking", "working", "waiting", "blocked", "done"];
const modes = [
  ["geometric", "Geometric"],
  ["mascot", "Mascot"],
  ["portrait", "Portrait"],
] as const;
const accessoryNames: Record<Accessory, string> = { none: "None", hat: "Cowboy hat", glasses: "Glasses" };
const sliders = [
  ["eyeWidth", "Eye width"],
  ["eyeHeight", "Eye height"],
  ["eyeSpacing", "Eye spacing"],
] as const;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

function Choice({ group, checked, label, onSelect, children }: {
  group: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label className="choice">
      <input className="sr-only" type="radio" name={group} checked={checked} onChange={onSelect} />
      <span className="choice-art" aria-hidden="true">{children}</span>
      <span className="choice-label">{label}</span>
    </label>
  );
}

/**
 * Visual avatar customization. Portrait upload and generation stay with the
 * caller, which owns storage; they render as `portraitControls`.
 */
export function AvatarEditor({ avatar, onChange, name, portraitControls }: {
  avatar: AvatarConfig;
  onChange: (avatar: AvatarConfig) => void;
  name?: string;
  portraitControls?: ReactNode;
}) {
  const id = useId();
  const [preview, setPreview] = useState<ActivityState>("idle");
  const drawn = avatar.mode === "portrait" ? null : avatar;
  // Switching styles keeps every earlier choice: the drawn character's colors and
  // eyes, the last shape and character, and a portrait chosen before.
  const lastDrawn = useRef<DrawnAvatar>(drawn ?? defaultAvatar);
  const lastShape = useRef<Shape>(drawn?.mode === "geometric" ? drawn.shape : "blob");
  const lastFamily = useRef<Family>(drawn?.mode === "mascot" ? drawn.family : "bear");
  const lastPortrait = useRef(avatar.mode === "portrait" ? avatar : null);
  if (drawn) lastDrawn.current = drawn;
  if (drawn?.mode === "geometric") lastShape.current = drawn.shape;
  if (drawn?.mode === "mascot") lastFamily.current = drawn.family;
  if (avatar.mode === "portrait" && avatar.src) lastPortrait.current = avatar;
  const switchMode = (mode: AvatarConfig["mode"]) => {
    if (mode === avatar.mode) return;
    const { color, eyes, accessory, eyeWidth, eyeHeight, eyeSpacing } = lastDrawn.current;
    const shared = { color, eyes, accessory, eyeWidth, eyeHeight, eyeSpacing };
    if (mode === "geometric") onChange({ ...shared, mode, shape: lastShape.current });
    else if (mode === "mascot") onChange({ ...shared, mode, family: lastFamily.current });
    else onChange(lastPortrait.current ?? { mode: "portrait", src: "", origin: "uploaded" });
  };
  const update = (patch: Partial<DrawnAvatar>) => drawn && onChange({ ...drawn, ...patch } as DrawnAvatar);
  return (
    <div className="avatar-editor">
      <div className="avatar-stage">
        <Avatar avatar={avatar} state={preview} size={124} name={name} />
        <div className="avatar-stage-states" role="group" aria-label="Preview a state">
          {previewStates.map((state) => (
            <button
              type="button"
              key={state}
              aria-pressed={preview === state}
              onClick={() => setPreview(state)}
            >
              {stateLabels[state]}
            </button>
          ))}
        </div>
        <p>Preview only. The real state always comes from Hermes.</p>
      </div>
      <fieldset className="segmented">
        <legend>Style</legend>
        {modes.map(([mode, label]) => (
          <label key={mode}>
            <input
              className="sr-only"
              type="radio"
              name={`${id}-mode`}
              checked={avatar.mode === mode}
              onChange={() => switchMode(mode)}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {drawn ? (
        <>
          {drawn.mode === "geometric" ? (
            <fieldset className="choice-group">
              <legend>Shape</legend>
              <div className="choice-grid">
                {shapes.map((shape) => (
                  <Choice key={shape} group={`${id}-shape`} label={title(shape)}
                    checked={drawn.shape === shape} onSelect={() => update({ shape })}>
                    <Avatar avatar={{ ...drawn, shape, accessory: "none" }} size={44} reducedMotion />
                  </Choice>
                ))}
              </div>
            </fieldset>
          ) : (
            <fieldset className="choice-group">
              <legend>Character</legend>
              <div className="choice-grid">
                {families.map((family) => (
                  <Choice key={family} group={`${id}-family`} label={title(family)}
                    checked={drawn.family === family} onSelect={() => update({ family })}>
                    <Avatar avatar={{ ...drawn, family, accessory: "none" }} size={44} reducedMotion />
                  </Choice>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="choice-group">
            <legend>Color</legend>
            <div className="swatches">
              {avatarColors.map((color) => (
                <label key={color} className="swatch" style={{ background: color }}>
                  <input
                    className="sr-only"
                    type="radio"
                    name={`${id}-color`}
                    aria-label={`Color ${color}`}
                    checked={drawn.color.toLowerCase() === color.toLowerCase()}
                    onChange={() => update({ color })}
                  />
                </label>
              ))}
              <label className="swatch swatch-custom" title="Custom color">
                <span className="sr-only">Custom color</span>
                <input type="color" value={drawn.color} onChange={(e) => update({ color: e.target.value })} />
              </label>
            </div>
          </fieldset>
          <fieldset className="choice-group">
            <legend>Eyes</legend>
            <div className="choice-grid">
              {eyeStyles.map((eyes) => (
                <Choice key={eyes} group={`${id}-eyes`} label={title(eyes)}
                  checked={drawn.eyes === eyes} onSelect={() => update({ eyes })}>
                  <Avatar avatar={{ ...drawn, eyes, accessory: "none" }} size={44} reducedMotion />
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="choice-group">
            <legend>Accessory</legend>
            <div className="choice-grid">
              {accessories.map((accessory) => (
                <Choice key={accessory} group={`${id}-accessory`} label={accessoryNames[accessory]}
                  checked={drawn.accessory === accessory} onSelect={() => update({ accessory })}>
                  <Avatar avatar={{ ...drawn, accessory }} size={44} reducedMotion />
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="choice-group eye-tuning">
            <legend>Fine-tune eyes</legend>
            {sliders.map(([key, label]) => (
              <label key={key}>
                <span>
                  {label}
                  <output>{Math.round((drawn[key] ?? 1) * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0.6"
                  max="1.5"
                  step="0.05"
                  value={drawn[key] ?? 1}
                  onChange={(e) => update({ [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            {sliders.some(([key]) => (drawn[key] ?? 1) !== 1) && (
              <button
                type="button"
                className="text-button"
                onClick={() => update({ eyeWidth: undefined, eyeHeight: undefined, eyeSpacing: undefined })}
              >
                Reset eyes
              </button>
            )}
          </fieldset>
        </>
      ) : (
        portraitControls
      )}
    </div>
  );
}
