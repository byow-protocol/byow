// The site's return page. A wallet that was reached by link navigates here with its answer in the URL; this
// hands the answer to the tab that asked and gets out of the way. It trusts nothing: the asking tab accepts
// an answer only for the request it sent, and the server still verifies every signature.
import { completeReturn } from "../../src/index.js";

document.getElementById("msg")!.textContent = completeReturn({ close: true }) ? "Done. Go back to the tab you came from." : "Nothing to hand back.";
