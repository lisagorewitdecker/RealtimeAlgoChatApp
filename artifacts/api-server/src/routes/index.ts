import { Router, type IRouter } from "express";
import moderationRouter from "./moderation";
import profileRouter from "./profile";
import roomsRouter from "./rooms";

const router: IRouter = Router();

router.use("/profile", profileRouter);
router.use("/rooms", roomsRouter);
router.use("/moderation", moderationRouter);

export default router;
