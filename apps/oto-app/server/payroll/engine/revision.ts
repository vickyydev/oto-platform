// Bumped by any change to the engine's numbers or inputs. R4's source
// signature includes it, so a deploy that changes the engine between GM
// confirm and Owner lock forces a reconfirm, as the prototype intended
// (plan §1, "The source signature on the server").
export const ENGINE_REVISION = "payroll-engine-r1-2026-10";
