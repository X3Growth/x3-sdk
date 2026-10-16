/** x3.video.js – lazy plugin for the script-tag core */
import { video } from "../plugins/video";
import { registerLazy } from "./lazy";

registerLazy(video());
