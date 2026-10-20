import { runChecks } from "./checks.js";
declare global {
  interface Window {
    runPackageChecks: typeof runChecks;
  }
}
window.runPackageChecks = runChecks;
