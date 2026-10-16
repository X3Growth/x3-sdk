/** x3.sections.js – lazy plugin for the script-tag core */
import { sections } from "../plugins/sections";
import { registerLazy } from "./lazy";

registerLazy(sections());
