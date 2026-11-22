import { useId, useRef, useState, type ReactNode } from "react";
import {
  avatarShapeGroups,
  type Accessory,
  type ActivityState,
  type Avatar as AvatarConfig,
  type AvatarShape,
  type Eyes,
} from "../shared/types";
import { Avatar, avatarColors, defaultAvatar, stateLabels } from "./Avatar";
import "./avatar-editor.css";
import { Icon } from "./Icon";
import { isSeasonal, seasonalColors, shapeGroups, shapeLabel } from "./avatar-shapes";

type DrawnAvatar = Exclude<AvatarConfig, { mode: "portrait" }>;

const eyeStyles: Eyes[] = ["oval", "round", "visor", "spark"];
const accessories: Accessory[] = ["none", "hat", "glasses"];
const previewStates: ActivityState[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
];
const modes = [
  ["geometric", "Character"],
  ["portrait", "Portrait"],
] as const;
const accessoryNames: Record<Accessory, string> = {
  none: "None",
  hat: "Cowboy hat",
  glasses: "Glasses",
};
const sliders = [
  ["eyeWidth", "Eye width"],
  ["eyeHeight", "Eye height"],
  ["eyeSpacing", "Eye spacing"],
] as const;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

function Choice({
  group,
  checked,
  label,
  onSelect,
  children,
}: {
  group: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label className="choice">
      <input className="sr-only" type="radio" name={group} checked={checked} onChange={onSelect} />
      <span className="choice-art" aria-hidden="true">
        {children}
      </span>
      <span className="choice-label">{label}</span>
    </label>
  );
}

/**
 * Visual avatar customization. Portrait upload and generation stay with the
 * caller, which owns storage; they render as `portraitControls`.
 */
export function AvatarEditor({
  avatar,
  onChange,
  name,
  portraitControls,
  compactPreview = false,
}: {
  avatar: AvatarConfig;
  onChange: (avatar: AvatarConfig) => void;
  name?: string;
  portraitControls?: ReactNode;
  compactPreview?: boolean;
}) {
  const id = useId();
  const [preview, setPreview] = useState<ActivityState>("idle");
  const drawn = avatar.mode === "portrait" ? null : avatar;
  // Switching styles keeps every earlier choice: the drawn character as it was, and a
  // portrait chosen before.
  const lastDrawn = useRef<DrawnAvatar>(drawn ?? defaultAvatar);
  const lastPortrait = useRef(avatar.mode === "portrait" ? avatar : null);
  if (drawn) lastDrawn.current = drawn;
  if (avatar.mode === "portrait" && avatar.src) lastPortrait.current = avatar;
  const switchMode = (mode: AvatarConfig["mode"]) => {
    if (mode === avatar.mode) return;
    if (mode === "geometric") onChange(lastDrawn.current);
    else onChange(lastPortrait.current ?? { mode: "portrait", src: "", origin: "uploaded" });
  };
  const update = (patch: Partial<DrawnAvatar>) => drawn && onChange({ ...drawn, ...patch });
  // A seasonal shape arrives in its own color; every other shape keeps the one already chosen.
  const tint = (shape: AvatarShape) => (isSeasonal(shape) ? { color: seasonalColors[shape] } : {});
  return (
    <div className={`avatar-editor${compactPreview ? " avatar-editor--compact" : ""}`}>
      <div className="avatar-stage">
        {compactPreview && avatar.mode === "portrait" && !avatar.src ? (
          <div className="avatar-portrait-empty" role="img" aria-label="No portrait selected">
            <Icon name="robot" size={compactPreview ? 36 : 56} />
          </div>
        ) : (
          <Avatar avatar={avatar} state={preview} size={compactPreview ? 64 : 124} name={name} />
        )}
        {compactPreview ? (
          <div className="avatar-preview-controls">
            <label>
              Preview state
              <select
                aria-describedby={`${id}-preview-note`}
                disabled={avatar.mode === "portrait" && !avatar.src}
                value={preview}
                onChange={(event) => setPreview(event.target.value as ActivityState)}
              >
                {previewStates.map((state) => (
                  <option key={state} value={state}>
                    {stateLabels[state]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <>
            <div className="avatar-stage-states" role="group" aria-label="Preview a state">
              {previewStates.map((state) => (
                <button
                  type="button"
                  key={state}
                  disabled={avatar.mode === "portrait" && !avatar.src}
                  aria-pressed={preview === state}
                  onClick={() => setPreview(state)}
                >
                  {stateLabels[state]}
                </button>
              ))}
            </div>
            <p>Preview only. The real state always comes from Hermes.</p>
          </>
        )}
      </div>
      {compactPreview && (
        <p className="avatar-preview-note" id={`${id}-preview-note`}>
          Preview only. Real activity comes from Hermes.
        </p>
      )}
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
          <fieldset className="choice-group">
            <legend>Shape</legend>
            {shapeGroups.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
                <p className="choice-category" id={`${id}-${group.id}`}>
                  {group.label}
                </p>
                <div className="choice-grid">
                  {avatarShapeGroups[group.id].map((shape: AvatarShape) => (
                    <Choice
                      key={shape}
                      group={`${id}-shape`}
                      label={shapeLabel(shape)}
                      checked={drawn.shape === shape}
                      onSelect={() => update({ shape, ...tint(shape) })}
                    >
                      <Avatar
                        avatar={{ ...drawn, shape, ...tint(shape), accessory: "none" }}
                        size={44}
                        reducedMotion
                      />
                    </Choice>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
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
              <label
                className="swatch swatch-custom"
                title="Custom color"
                data-selected={
                  !avatarColors.some((color) => color.toLowerCase() === drawn.color.toLowerCase())
                }
              >
                <span className="sr-only">Custom color</span>
                <input
                  type="color"
                  value={drawn.color}
                  onChange={(e) => update({ color: e.target.value })}
                />
              </label>
            </div>
          </fieldset>
          <fieldset className="choice-group">
            <legend>Eyes</legend>
            <div className="choice-grid">
              {eyeStyles.map((eyes) => (
                <Choice
                  key={eyes}
                  group={`${id}-eyes`}
                  label={title(eyes)}
                  checked={drawn.eyes === eyes}
                  onSelect={() => update({ eyes })}
                >
                  <Avatar avatar={{ ...drawn, eyes, accessory: "none" }} size={44} reducedMotion />
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="choice-group">
            <legend>Accessory</legend>
            <div className="choice-grid">
              {accessories.map((accessory) => (
                <Choice
                  key={accessory}
                  group={`${id}-accessory`}
                  label={accessoryNames[accessory]}
                  checked={drawn.accessory === accessory}
                  onSelect={() => update({ accessory })}
                >
                  <Avatar avatar={{ ...drawn, accessory }} size={44} reducedMotion />
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="choice-group eye-tuning">
            <legend>Fine-tune eyes</legend>
            {sliders.map(([key, label]) => (
              <label key={key} htmlFor={`${id}-${key}`}>
                <span>
                  {label}
                  <output>{Math.round((drawn[key] ?? 1) * 100)}%</output>
                </span>
                <input
                  id={`${id}-${key}`}
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
                onClick={() =>
                  update({ eyeWidth: undefined, eyeHeight: undefined, eyeSpacing: undefined })
                }
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
