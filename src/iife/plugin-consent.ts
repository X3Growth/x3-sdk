/** x3.consent.js – lazy plugin for the script-tag core */
import { consent } from "../plugins/consent";
import { registerLazy } from "./lazy";

registerLazy(consent());
