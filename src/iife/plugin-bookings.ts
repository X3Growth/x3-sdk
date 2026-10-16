/** x3.bookings.js – lazy plugin for the script-tag core */
import { bookings } from "../plugins/bookings";
import { registerLazy } from "./lazy";

registerLazy(bookings());
