/** x3.capture.js – owner capture of page states (one-time capture link, §5.8) */
import { capture } from "../plugins/capture";
import { registerLazy } from "./lazy";

registerLazy(capture());
