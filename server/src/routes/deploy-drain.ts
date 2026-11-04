import { Router } from "express";
import { assertAuthenticated } from "./authz.js";
import { readDeployDrain } from "../services/deploy-drain.js";

/** inferdyne fork: state of a planned board upgrade, for the UI banner. */
export function deployDrainRoutes() {
  const router = Router();
  router.get("/deploy-drain", (req, res) => {
    assertAuthenticated(req);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(readDeployDrain());
  });
  return router;
}
