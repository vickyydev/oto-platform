import { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "./db";
import { users, people, authOtpEvents } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { hashPassword, requireAuth } from "./auth";
import {
  isTwilioConfigured,
  normalizePhoneToE164,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
  sendPhoneVerificationOtp,
  verifyPhoneOtp,
  validateResetToken,
  validateAdvisorResetToken,
  sendAdvisorPasswordResetOtp,
  verifyAdvisorPasswordResetOtp,
} from "./twilio-service";

const phoneSchema = z.object({
  phone: z.string().min(8).max(20),
  countryCode: z.string().default("+66"),
});

const verifyOtpSchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().length(6),
  countryCode: z.string().default("+66"),
});

const resetPasswordSchema = z.object({
  resetToken: z.string(),
  newPassword: z.string().min(6),
});

function getClientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress;
}

export function registerAuthOtpRoutes(app: Express) {
  const hasSessionSecret = !!process.env.SESSION_SECRET;
  
  app.get("/api/auth/sms-otp/status", (req, res) => {
    const twilioConfigured = isTwilioConfigured();
    const fullyConfigured = twilioConfigured && hasSessionSecret;
    res.json({
      configured: fullyConfigured,
      enabled: fullyConfigured,
      twilioConfigured,
      sessionSecretConfigured: hasSessionSecret,
    });
  });

  app.post("/api/auth/forgot-password/request-otp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = phoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid phone number format" });
      }

      const { phone, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];

      const result = await sendPasswordResetOtp(phoneE164, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        message: "Verification code sent to your phone",
        maskedPhone: phoneE164.slice(0, 4) + "****" + phoneE164.slice(-2),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/forgot-password/verify-otp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = verifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid verification code format" });
      }

      const { phone, code, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];

      const result = await verifyPasswordResetOtp(phoneE164, code, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        resetToken: result.resetToken,
        message: "Verification successful. You can now reset your password.",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/forgot-password/reset", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request. Password must be at least 6 characters." });
      }

      const { resetToken, newPassword } = parsed.data;

      const validation = await validateResetToken(resetToken);
      if (!validation.valid || !validation.userId) {
        return res.status(400).json({ message: validation.error || "Invalid or expired reset token" });
      }

      const hashedPassword = await hashPassword(newPassword);

      await db.update(users)
        .set({
          password: hashedPassword,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, validation.userId));

      await db.insert(authOtpEvents).values({
        userId: validation.userId,
        phoneE164: validation.phoneE164 || "unknown",
        eventType: "password_reset",
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
        success: true,
      });

      res.json({
        success: true,
        message: "Password reset successfully. You can now log in with your new password.",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/phone/request-verification", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = phoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid phone number format" });
      }

      const { phone, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];
      const userId = req.user!.id;

      const existingUser = await db.select()
        .from(users)
        .where(and(
          eq(users.phoneE164, phoneE164),
          eq(users.phoneVerified, true)
        ))
        .limit(1);

      if (existingUser.length > 0 && existingUser[0].id !== userId) {
        return res.status(400).json({ message: "This phone number is already verified by another account" });
      }

      await db.update(users)
        .set({
          phoneNumber: phone,
          phoneE164: phoneE164,
          phoneVerified: false,
          phoneVerifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      const result = await sendPhoneVerificationOtp(phoneE164, userId, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        message: "Verification code sent to your phone",
        maskedPhone: phoneE164.slice(0, 4) + "****" + phoneE164.slice(-2),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/phone/verify", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = verifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid verification code format" });
      }

      const { phone, code, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];
      const userId = req.user!.id;

      const result = await verifyPhoneOtp(phoneE164, code, userId, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        message: "Phone number verified successfully",
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/auth/phone", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      await db.update(users)
        .set({
          phoneNumber: null,
          phoneE164: null,
          phoneVerified: false,
          phoneVerifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      res.json({
        success: true,
        message: "Phone number removed from your account",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/advisor/forgot-password/request-otp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = phoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid phone number format" });
      }

      const { phone, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];

      const result = await sendAdvisorPasswordResetOtp(phoneE164, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        message: "Verification code sent to your phone",
        maskedPhone: phoneE164.slice(0, 4) + "****" + phoneE164.slice(-2),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/advisor/forgot-password/verify-otp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = verifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid verification code format" });
      }

      const { phone, code, countryCode } = parsed.data;
      const phoneE164 = normalizePhoneToE164(phone, countryCode);
      const ipAddress = getClientIp(req);
      const userAgent = req.headers["user-agent"];

      const result = await verifyAdvisorPasswordResetOtp(phoneE164, code, ipAddress, userAgent);

      if (!result.success) {
        return res.status(400).json({ message: result.error });
      }

      res.json({
        success: true,
        resetToken: result.resetToken,
        personId: result.personId,
        message: "Verification successful. You can now set your password.",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/advisor/forgot-password/reset", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request. Password must be at least 6 characters." });
      }

      const { resetToken, newPassword } = parsed.data;

      const validation = await validateAdvisorResetToken(resetToken);
      if (!validation.valid || !validation.personId) {
        return res.status(400).json({ message: validation.error || "Invalid or expired reset token" });
      }

      const hashedPassword = await hashPassword(newPassword);

      // Advisors authenticate via their linked users record (matched by email)
      const [person] = await db.select({ email: people.email })
        .from(people)
        .where(eq(people.id, validation.personId))
        .limit(1);

      if (!person) {
        return res.status(400).json({ message: "Advisor account not found" });
      }

      await db.update(users)
        .set({
          password: hashedPassword,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.email, person.email));

      await db.insert(authOtpEvents).values({
        phoneE164: validation.phoneE164 || "unknown",
        eventType: "password_reset",
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
        success: true,
      });

      res.json({
        success: true,
        message: "Password set successfully. You can now log in with your new password.",
      });
    } catch (error) {
      next(error);
    }
  });
}
