import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inviteRouter from "./invite";

const router: IRouter = Router();

router.use(healthRouter);
router.use(inviteRouter);

export default router;
