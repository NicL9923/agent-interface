import {
  avatarShapeGroups,
  type AvatarShape,
  type AvatarShapeGroup,
  type SeasonalShape,
} from "../shared/types";
import { shapeArt } from "./avatar-shape-art";

/**
 * Where a silhouette's face sits. Eyes follow the visual center of mass, so a triangle or drop
 * looks out from its wide base instead of its point, and a mug looks out from its cup.
 */
export interface Face {
  /** The middle of the eye pair across the body; 50 when absent. */
  cx?: number;
  cy: number;
  /** Eye size, against the full-size eyes of the blob. */
  scale: number;
  /** Distance between the eye centers; 30 times `scale` when absent. */
  spacing?: number;
  /**
   * The radius of the sphere the face turns on. It is the half-width of the part the face sits
   * on, so eyes never slide off a narrow part onto a handle or a wing. FACE_RADIUS when absent.
   */
  radius?: number;
  /** The top of the head and the size of a hat on it. */
  top: number;
  hat: number;
}
export interface ShapeArt {
  /**
   * The outline in a 0-100 box, as absolute M L H V Q C Z only: ios/AgentInterface/AvatarCatalog.swift
   * repeats these strings and its reader takes nothing else. The first contour is the outside;
   * any later one is a hole, wound the other way.
   */
  path: string;
  face: Face;
}

/** The app's own shapes: one closed outline each, filling the box. */
const classic: Record<(typeof avatarShapeGroups.classic)[number], ShapeArt> = {
  blob: {
    path: "M50 3 C77 1 99 24 98 51 C100 77 79 99 51 98 C23 99 2 80 2 51 C2 25 21 3 50 3Z",
    face: { cy: 50, scale: 1, top: 3, hat: 1 },
  },
  pebble: {
    path: "M22 9 C48 -4 86 7 94 32 C105 60 90 90 69 96 C36 105 2 88 4 63 C1 38 7 21 22 9Z",
    face: { cy: 50, scale: 1, top: 2, hat: 1 },
  },
  squircle: {
    path: "M25 5 H75 Q95 5 95 25 V75 Q95 95 75 95 H25 Q5 95 5 75 V25 Q5 5 25 5Z",
    face: { cy: 50, scale: 1, top: 5, hat: 1 },
  },
  capsule: {
    path: "M48 5 H52 C75 5 84 18 84 40 V61 C84 83 73 96 52 96 H48 C26 96 16 84 16 61 V40 C16 18 26 5 48 5Z",
    face: { cy: 47, scale: 0.9, top: 5, hat: 0.85 },
  },
  triangle: {
    path: "M43 12 Q50 0 57 12 L95 78 Q103 94 85 94 H15 Q-3 94 5 78Z",
    face: { cy: 65, scale: 0.82, top: 3, hat: 0.6 },
  },
  hex: {
    path: "M28 8 Q32 5 37 5 H64 Q70 5 73 10 L95 43 Q99 50 95 57 L73 90 Q70 95 64 95 H36 Q30 95 27 90 L5 57 Q1 50 5 43Z",
    face: { cy: 50, scale: 0.95, top: 5, hat: 0.95 },
  },
  drop: {
    path: "M50 7 C42 16 13 42 13 64 C13 87 29 95 50 95 C71 95 87 82 87 62 C87 39 61 17 50 7Z",
    face: { cy: 63, scale: 0.9, top: 8, hat: 0.62 },
  },
  circle: {
    path: "M50 3 C75.96 3 97 24.04 97 50 C97 75.96 75.96 97 50 97 C24.04 97 3 75.96 3 50 C3 24.04 24.04 3 50 3Z",
    face: { cy: 50, scale: 1, top: 3, hat: 1 },
  },
  diamond: {
    path: "M50 5.1 C56.3 5.1 60 9.6 64.1 13.7 C71.8 21.4 79.5 29.1 87.1 36.7 C91 40.6 95 44.1 95 50 C95 56.3 90.4 60 86.3 64.1 C78.5 71.8 70.8 79.6 63.1 87.3 C59.3 91.1 55.8 94.9 50 94.9 C43.7 94.9 40 90.3 35.9 86.2 C28.2 78.5 20.4 70.8 12.7 63.1 C8.9 59.3 5 55.8 5 50 C5 43.7 9.6 40 13.7 35.8 C21.4 28.1 29.2 20.4 36.9 12.7 C40.7 8.9 44.2 5.1 50 5.1Z",
    face: { cy: 50, scale: 0.88, top: 7, hat: 0.7 },
  },
  sparkle: {
    path: "M50 4.1 C58.3 4.1 61.2 11.9 65.5 17.6 C72.2 26.5 80.6 33.7 90 39.6 C93.6 41.9 95.9 45.6 95.9 50 C95.9 54.3 93.7 58 90.1 60.3 C80.7 66.3 72.4 73.3 65.6 82.2 C61.2 88 58.4 96 49.9 95.9 C45.7 95.9 41.9 93.7 39.7 90.1 C33.7 80.6 26.5 72.3 17.5 65.5 C11.9 61.2 4.1 58.4 4.1 50.1 C4 41.7 11.9 38.9 17.6 34.5 C26.6 27.7 33.7 19.4 39.7 9.9 C42 6.3 45.7 4.1 50 4.1Z",
    face: { cy: 50, scale: 0.8, top: 6, hat: 0.6 },
  },
  clover: {
    path: "M50 4 C58.7 4 66.8 9.1 70.6 16.9 C71.8 19.3 72.4 24.5 73.9 26 C75.5 27.6 80.6 28.1 83 29.3 C90.9 33.1 96 41.2 96 49.9 C96 58.4 91.2 66.5 83.6 70.4 C81.2 71.7 75.2 72.6 73.9 74 C72.6 75.4 71.6 81.2 70.4 83.6 C66.6 91.1 58.6 96 50.2 96 C41.4 96 33.3 91 29.4 83.2 C28.2 80.8 27.6 75.5 26 73.9 C24.4 72.4 19.4 71.9 17.1 70.7 C9.1 66.9 4 58.7 4 50 C4 41.5 8.9 33.4 16.5 29.5 C18.9 28.3 24.7 27.4 26.1 26 C27.4 24.7 28.3 18.9 29.5 16.5 C33.4 8.9 41.5 4 50 4Z",
    face: { cy: 50, scale: 0.95, top: 5, hat: 0.75 },
  },
  heart: {
    path: "M50 17.2 C53.1 17.2 57.3 13.3 60.6 12 C69.7 8.5 80.4 10.8 87.4 17.7 C89.5 19.7 91.2 22.2 92.5 24.8 C96.4 32.8 95.7 42.6 90.7 50 C88.4 53.4 85.4 56.2 82.6 59.2 C78.3 63.9 74 68.6 69.7 73.3 C66.4 76.8 59.3 85.7 55.8 87.9 C54.1 89 52.1 89.6 50 89.6 C47.9 89.6 45.8 89 44 87.8 C40.6 85.5 33.6 76.9 30.4 73.4 C26 68.7 21.7 63.9 17.4 59.2 C14.7 56.3 11.6 53.4 9.4 50.1 C4.3 42.7 3.7 32.9 7.5 24.9 C8.7 22.2 10.5 19.8 12.6 17.7 C19.5 10.9 30 8.6 39.2 11.9 C42.4 13.1 47.1 17.2 50 17.2Z",
    face: { cy: 48, scale: 0.95, top: 12, hat: 0.75 },
  },
  cookie: {
    path: "M50 5.5 C53.6 5.4 57.2 7 59.8 9.6 C61 10.8 61.8 13.2 63.4 13.8 C65.2 14.5 67.4 13.1 69.2 13 C72.8 12.6 76.5 13.8 79.3 16.1 C82.1 18.5 83.8 22 84.1 25.6 C84.2 27.3 83.3 29.7 84.2 31.3 C85.1 32.8 87.5 33.1 89 34.1 C92 36.1 94.1 39.4 94.8 43 C95.5 46.6 94.6 50.5 92.4 53.5 C91.3 54.9 89.2 56 88.9 57.8 C88.6 59.6 90.3 61.6 90.8 63.4 C91.7 66.9 91.2 70.6 89.4 73.7 C87.6 76.8 84.6 79.1 81.1 80.1 C79.4 80.5 76.8 80 75.4 81.2 C74 82.3 74 85 73.3 86.6 C71.8 89.9 68.9 92.5 65.5 93.7 C62 95 58.2 94.7 54.9 93.1 C53.3 92.4 51.8 90.5 50 90.4 C48.2 90.4 46.7 92.4 45.1 93.1 C41.9 94.7 38 95 34.6 93.8 C31 92.5 28.1 89.8 26.6 86.4 C25.9 84.8 26 82.4 24.7 81.2 C23.3 80 20.6 80.5 18.9 80.1 C15.4 79.2 12.4 76.8 10.6 73.8 C8.8 70.6 8.3 66.8 9.3 63.2 C9.7 61.5 11.4 59.6 11.1 57.8 C10.8 56.1 8.7 54.9 7.7 53.6 C5.4 50.6 4.5 46.7 5.2 43 C5.9 39.4 8 36.2 11 34.1 C12.5 33.1 15.1 32.7 15.9 31.1 C16.7 29.6 15.8 27.3 15.9 25.7 C16.2 22 17.9 18.5 20.7 16.2 C23.5 13.8 27.1 12.6 30.8 13 C32.6 13.1 34.8 14.5 36.5 13.9 C38.2 13.2 39 10.8 40.2 9.6 C42.7 7 46.3 5.5 50 5.5Z",
    face: { cy: 50, scale: 0.95, top: 6, hat: 0.95 },
  },
  pentagon: {
    path: "M50 7.6 C54.9 7.6 58.4 11 62.2 13.7 C69.6 19 76.9 24.4 84.3 29.8 C87.9 32.4 91.9 34.7 93.4 39.1 C94.9 43.6 92.9 47.9 91.5 52.1 C88.8 60.5 86.1 69 83.3 77.4 C81.9 81.7 81.1 86.5 77.6 89.5 C73.9 92.8 69.2 92.4 64.5 92.4 C55.1 92.4 45.7 92.4 36.3 92.4 C31.4 92.4 26.4 93 22.4 89.6 C19 86.6 18.1 81.8 16.8 77.7 C14 69.2 11.3 60.7 8.5 52.1 C7.1 47.9 5.1 43.6 6.6 39.1 C8.1 34.6 12.2 32.3 15.8 29.7 C23.3 24.3 30.7 18.8 38.1 13.5 C41.8 10.8 45.2 7.6 50 7.6Z",
    face: { cy: 54, scale: 0.92, top: 7, hat: 0.7 },
  },
  burst: {
    path: "M50 5.1 C53.8 5 63 14.3 67.1 16.3 C71.4 18.6 83.7 19.5 86.5 22.5 C88.7 24.8 88 29.4 88.1 32.3 C88.2 35.5 87.9 41 88.8 43.8 C90.1 47.8 96.6 59.1 95.9 62.5 C95.2 65.6 91 68 88.8 69.9 C81.2 76.5 81.8 75.1 77 84 C75.6 86.8 73.2 93.2 70.4 94.5 C66.7 96.2 54.7 91.6 49.9 91.7 C45.3 91.8 33.2 96.1 29.7 94.5 C26.9 93.2 24.4 86.8 23 84 C18.1 74.9 18.8 76.5 11.1 69.8 C8.9 67.9 4.8 65.6 4.2 62.6 C3.3 59 9.8 47.9 11.2 43.9 C12.1 41.1 11.8 35.5 11.9 32.4 C12 29.4 11.3 24.9 13.5 22.5 C16.2 19.5 28.6 18.5 32.9 16.4 C37.1 14.3 46 5.1 50 5.1Z",
    face: { cy: 51, scale: 0.9, top: 6, hat: 0.75 },
  },
  alien: {
    path: "M50 6 C66.4 6 85.1 13.5 91.8 29.5 C94.1 34.8 94.6 40.7 93.2 46.3 C90.7 56.9 80.7 65.3 73.5 73.1 C69.1 78 64.7 82.8 60.2 87.6 C57.3 90.8 54.7 94 50 94 C45.3 94 42.6 90.7 39.6 87.5 C35.2 82.7 30.8 77.8 26.3 73 C19.1 65.1 9.1 56.6 6.7 45.9 C5.4 40.5 6 34.9 8.1 29.7 C14.6 13.6 33.6 6 50 6Z",
    face: { cy: 42, scale: 1, top: 6, hat: 1 },
  },
  flower: {
    path: "M50 5.4 C57.2 5.4 63.9 9.6 66.9 16.1 C68.1 18.5 68.2 23.4 70.3 24.9 C72.4 26.4 76.6 25 79.2 25.2 C86.5 26 92.8 31.1 95 38 C97.3 44.9 95.3 52.7 90 57.6 C88 59.5 83.6 61 82.8 63.4 C82 66.2 84.6 69.4 85.2 72 C86.7 79.1 83.8 86.8 77.9 91 C72 95.3 64 95.8 57.7 92.3 C55.3 90.9 52.6 87.3 50 87.3 C47.4 87.3 44.5 91.1 42.1 92.4 C35.8 95.8 27.8 95.2 22 91 C16.2 86.7 13.4 79.3 14.8 72.2 C15.3 69.6 18 65.9 17.2 63.4 C16.4 60.9 12.1 59.6 10.2 57.8 C4.7 52.8 2.6 45 5 38 C7.3 31.1 13.4 26.1 20.6 25.3 C23.2 24.9 27.6 26.4 29.7 24.8 C31.8 23.3 31.9 18.5 33.1 16 C36.2 9.6 42.9 5.4 50 5.4Z",
    face: { cy: 51, scale: 0.85, top: 8, hat: 0.75 },
  },
  sun: {
    path: "M50 4.1 C52.7 4 55.1 14.4 58.1 15.5 C58.9 15.9 60.3 16.3 61.2 16.2 C64 15.6 70.1 9.8 72.4 10 C74.1 10.2 73.8 12.3 73.8 13.6 C73.7 15.8 73 22.7 74.3 24.2 C74.8 24.9 75.7 25.9 76.4 26.2 C77.8 26.9 83.7 26.3 85.6 26.3 C86.9 26.3 89.6 25.7 90 27.5 C90.5 29.6 84.3 36.2 83.9 38.9 C83.7 39.8 84.2 41 84.5 41.8 C85.6 45 95.8 47.1 95.9 49.9 C96.1 52.7 85.7 55.1 84.5 58 C84.2 58.9 83.7 60.3 83.9 61.2 C84.4 63.8 90.5 70.5 90 72.6 C89.5 74.4 86.8 73.8 85.5 73.8 C83.5 73.8 78.2 73.2 76.6 73.8 C75.8 74.1 75 75 74.4 75.7 C72.9 77.3 73.7 83.9 73.8 86.3 C73.8 87.5 74.2 89.6 72.6 90 C70.5 90.5 63.8 84.3 61.2 83.9 C60.3 83.7 59 84.2 58.2 84.5 C55 85.6 52.9 95.8 50.1 95.9 C47.4 96.1 44.9 85.7 42 84.5 C41.2 84.2 39.8 83.7 38.9 83.9 C36.3 84.3 29.5 90.5 27.5 90 C25.8 89.6 26.3 87.5 26.3 86.3 C26.3 83.9 27.1 77.3 25.6 75.7 C25.1 75.1 24.4 74.2 23.6 73.8 C22.3 73.2 16.4 73.8 14.5 73.8 C13.2 73.8 10.5 74.4 10.1 72.6 C9.6 70.5 15.7 63.8 16.2 61.2 C16.3 60.3 15.9 58.8 15.5 58 C14.4 55.2 3.9 52.6 4.1 50 C4.2 47.2 14.4 45 15.6 41.9 C15.9 41.1 16.3 39.8 16.2 38.9 C15.8 36.2 9.6 29.8 10 27.5 C10.4 25.7 13.1 26.3 14.4 26.3 C16.4 26.3 22.1 26.9 23.6 26.2 C24.3 25.9 25.2 24.9 25.7 24.3 C27.1 22.7 26.3 15.9 26.3 13.6 C26.2 12.4 25.9 10.3 27.6 10 C30 9.7 36.2 15.9 39 16.2 C39.9 16.3 41.2 15.9 42 15.5 C44.9 14.4 47.3 4.1 50 4.1Z",
    face: { cy: 50, scale: 0.85, top: 15, hat: 0.8 },
  },
};

// An outline the art tool wrote for an id that avatarShapes does not list would never be drawn.
type Unlisted = Exclude<keyof typeof shapeArt, AvatarShape>;
true satisfies [Unlisted] extends [never] ? true : never;

/**
 * Every avatar shape. The objects, creatures and seasonal shapes are written by
 * .agents/tools/avatar-shapes.mjs: 23 are Open Bot Avatar definitions (MIT, Dominik Scholz) and
 * the rest were drawn for this app in the same format. docs/AvatarShapes.md lists which is which.
 */
export const shapes: Record<AvatarShape, ShapeArt> = { ...classic, ...shapeArt };

/** The name under a shape's tile, and what a screen reader calls it. */
export function shapeLabel(shape: AvatarShape) {
  if (shape === "tars") return "TARS";
  const words = shape.replace("-", " ");
  return words[0].toUpperCase() + words.slice(1);
}
/** The shape picker's sections, in order, with their headings. */
export const shapeGroups: { id: AvatarShapeGroup; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "objects", label: "Objects" },
  { id: "creatures", label: "Creatures" },
  { id: "seasonal", label: "Seasonal" },
];
/** The color a seasonal shape arrives in when picked: a pumpkin is orange until someone says otherwise. */
export const seasonalColors: Record<SeasonalShape, string> = {
  pumpkin: "#FF6700",
  bat: "#5E4B8B",
  turkey: "#97683D",
  "santa-hat": "#FF263C",
  reindeer: "#97683D",
  snowman: "#F4F8FB",
};
export function isSeasonal(shape: AvatarShape): shape is SeasonalShape {
  return Object.hasOwn(seasonalColors, shape);
}
/** An outline without its holes, such as a mug's handle. A shape morphs along its outside only. */
export const outside = (path: string) => path.slice(0, path.indexOf("Z") + 1);
