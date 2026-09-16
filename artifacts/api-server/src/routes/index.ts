import { Router, type IRouter } from "express";
import adminRouter from "./admin";
import moderationRouter from "./moderation";
import profileRouter from "./profile";
import roomsRouter from "./rooms";

const router: IRouter = Router();

router.use("/admin", adminRouter);
router.use("/profile", profileRouter);
router.use("/rooms", roomsRouter);
router.use("/moderation", moderationRouter);

export default router;
