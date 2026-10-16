/** x3.full.js – script-tag core with every plugin bundled (no lazy loads) */
import { bookings } from "../plugins/bookings";
import { consent } from "../plugins/consent";
import { forms } from "../plugins/forms";
import { identify } from "../plugins/identify";
import { journeys } from "../plugins/journeys";
import { sections } from "../plugins/sections";
import { video } from "../plugins/video";
import { boot } from "./boot";

boot([video(), sections(), forms(), identify(), consent(), bookings(), journeys()], false);
