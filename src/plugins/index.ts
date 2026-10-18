/**
 * @x3growth/sdk/plugins – tree-shakeable plugins for the npm build:
 *
 *   import { init } from "@x3growth/sdk";
 *   import { video, sections, forms } from "@x3growth/sdk/plugins";
 *   init({ key: "pk_3x_…", plugins: [video(), sections(), forms()] });
 *
 * Without explicit plugins the SDK loads the ones the project config enables
 * on demand (dynamic import in the npm build, x3.<plugin>.js for the script tag).
 */
export { video, addRange, bitmapHex } from "./video";
export { sections } from "./sections";
export { forms } from "./forms";
export { identify, hashIdentify } from "./identify";
export { consent, CMP_ADAPTERS, type CmpName } from "./consent";
export { bookings, bookingFromMessage, bridgeProps } from "./bookings";
export { journeys } from "./journeys";
export { experiments } from "./experiments";
