import { Router, type IRouter } from "express";
import healthRouter from "./health";
import extDbRouter from "./extdb";

const router: IRouter = Router();

router.use(healthRouter);
router.use(extDbRouter);

export default router;
