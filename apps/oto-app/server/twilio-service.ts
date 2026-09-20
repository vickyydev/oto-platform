import Twilio from "twilio";
import crypto from "crypto";
import { db } from "./db";
import { authOtpEvents, authRateLimits, authResetTokens, users, people, InsertAuthOtpEvent } from "@shared/schema";
import { eq, and, gt, sql, lt } from "drizzle-orm";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const RESET_TOKEN_SECRET = process.env.SESSION_SECRET;

if (!RESET_TOKEN_SECRET) {
  console.error("[Security] CRITICAL: SESSION_SECRET not set - password reset via SMS OTP is DISABLED for security!");
}

async function cleanupExpiredTokens() {
  try {
    await db.delete(authResetTokens)
      .where(lt(authResetTokens.expiresAt, new Date()));
  } catch (error) {
    console.error("[Twilio] Failed to cleanup expired tokens:", error);
  }
}

setInterval(cleanupExpiredTokens, 60000);

let twilioClient: Twilio.Twilio | null = null;

function getTwilioClient(): Twilio.Twilio {
  if (!twilioClient) {
    if (!accountSid || !authToken) {
      throw new Error("Twilio credentials not configured");
    }
    twilioClient = Twilio(accountSid, authToken);
  }
  return twilioClient;
}

export function isTwilioConfigured(): boolean {
  return !!(accountSid && authToken && verifyServiceSid);
}

export function normalizePhoneToE164(phone: string, defaultCountryCode: string = "+66"): string {
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, "");
  
  if (cleaned.startsWith("+")) {
    return cleaned;
  }
  
  if (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }
  
  if (!defaultCountryCode.startsWith("+")) {
    defaultCountryCode = "+" + defaultCountryCode;
  }
  
  return defaultCountryCode + cleaned;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_OTP_REQUESTS_PER_PHONE = 3;
const MAX_OTP_REQUESTS_PER_IP = 10;
const MAX_OTP_VERIFY_ATTEMPTS_PER_PHONE = 5; // Max verification attempts per phone per hour

async function createResetToken(data: { userId?: string; personId?: string; type: string; phoneE164: string }): Promise<string> {
  if (!RESET_TOKEN_SECRET) {
    throw new Error("SESSION_SECRET not configured - cannot create secure reset tokens");
  }
  
  const tokenId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  
  await db.insert(authResetTokens).values({
    id: tokenId,
    userId: data.userId || null,
    personId: data.personId || null,
    tokenType: data.type,
    phoneE164: data.phoneE164,
    used: false,
    expiresAt,
  });
  
  const signature = crypto.createHmac("sha256", RESET_TOKEN_SECRET).update(tokenId).digest("hex");
  return `${tokenId}.${signature}`;
}

async function validateResetTokenInternal(token: string): Promise<{ valid: boolean; data?: { userId?: string | null; personId?: string | null; type: string; phoneE164: string }; error?: string }> {
  if (!RESET_TOKEN_SECRET) {
    return { valid: false, error: "Password reset is not available - server misconfigured" };
  }
  
  if (!token.includes(".")) {
    return { valid: false, error: "Invalid token format" };
  }
  
  const [tokenId, signature] = token.split(".");
  if (!tokenId || !signature) {
    return { valid: false, error: "Invalid token format" };
  }
  
  const expectedSignature = crypto.createHmac("sha256", RESET_TOKEN_SECRET).update(tokenId).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return { valid: false, error: "Token signature invalid" };
  }
  
  const result = await db.update(authResetTokens)
    .set({ used: true })
    .where(and(
      eq(authResetTokens.id, tokenId),
      eq(authResetTokens.used, false),
      gt(authResetTokens.expiresAt, new Date())
    ))
    .returning();
  
  if (result.length === 0) {
    const existing = await db.select()
      .from(authResetTokens)
      .where(eq(authResetTokens.id, tokenId))
      .limit(1);
    
    if (existing.length === 0) {
      return { valid: false, error: "Invalid or expired token" };
    }
    if (existing[0].used) {
      return { valid: false, error: "Token has already been used" };
    }
    if (existing[0].expiresAt < new Date()) {
      return { valid: false, error: "Token has expired" };
    }
    return { valid: false, error: "Invalid token" };
  }
  
  const stored = result[0];
  return {
    valid: true,
    data: {
      userId: stored.userId,
      personId: stored.personId,
      type: stored.tokenType,
      phoneE164: stored.phoneE164,
    },
  };
}

async function checkRateLimit(key: string, maxRequests: number): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  
  const existing = await db.select()
    .from(authRateLimits)
    .where(and(
      eq(authRateLimits.key, key),
      gt(authRateLimits.expiresAt, now)
    ))
    .limit(1);
  
  if (existing.length === 0) {
    await db.insert(authRateLimits).values({
      key,
      windowStart: now,
      count: 1,
      expiresAt: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS),
    });
    return { allowed: true, remaining: maxRequests - 1 };
  }
  
  const record = existing[0];
  if (record.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }
  
  await db.update(authRateLimits)
    .set({ count: record.count + 1 })
    .where(eq(authRateLimits.id, record.id));
  
  return { allowed: true, remaining: maxRequests - record.count - 1 };
}

async function logOtpEvent(event: InsertAuthOtpEvent): Promise<void> {
  await db.insert(authOtpEvents).values(event);
}

export async function sendPasswordResetOtp(
  phoneE164: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string; userId?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const phoneRateLimit = await checkRateLimit(`otp:phone:${phoneE164}`, MAX_OTP_REQUESTS_PER_PHONE);
  if (!phoneRateLimit.allowed) {
    await logOtpEvent({
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: false,
      failReason: "rate_limited_phone",
    });
    return { success: false, error: "Too many OTP requests. Please try again later." };
  }
  
  if (ipAddress) {
    const ipRateLimit = await checkRateLimit(`otp:ip:${ipAddress}`, MAX_OTP_REQUESTS_PER_IP);
    if (!ipRateLimit.allowed) {
      await logOtpEvent({
        phoneE164,
        eventType: "request",
        ipAddress,
        userAgent,
        success: false,
        failReason: "rate_limited_ip",
      });
      return { success: false, error: "Too many OTP requests from your location. Please try again later." };
    }
  }
  
  const user = await db.select()
    .from(users)
    .where(and(
      eq(users.phoneE164, phoneE164),
      eq(users.phoneVerified, true),
      eq(users.isActive, true)
    ))
    .limit(1);
  
  if (user.length === 0) {
    await logOtpEvent({
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: false,
      failReason: "phone_not_found_or_unverified",
    });
    return { success: false, error: "No account found with this verified phone number" };
  }
  
  try {
    const client = getTwilioClient();
    await client.verify.v2.services(verifyServiceSid!)
      .verifications
      .create({ to: phoneE164, channel: "sms" });
    
    await logOtpEvent({
      userId: user[0].id,
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: true,
    });
    
    return { success: true, userId: user[0].id };
  } catch (error: any) {
    console.error("[Twilio] Failed to send OTP:", error.message);
    await logOtpEvent({
      userId: user[0].id,
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: false,
      failReason: error.message || "twilio_error",
    });
    return { success: false, error: "Failed to send verification code. Please try again." };
  }
}

export async function verifyPasswordResetOtp(
  phoneE164: string,
  code: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string; userId?: string; resetToken?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const verifyRateLimit = await checkRateLimit(`verify:phone:${phoneE164}`, MAX_OTP_VERIFY_ATTEMPTS_PER_PHONE);
  if (!verifyRateLimit.allowed) {
    await logOtpEvent({
      phoneE164,
      eventType: "verify_fail",
      ipAddress,
      userAgent,
      success: false,
      failReason: "verify_rate_limited",
    });
    return { success: false, error: "Too many verification attempts. Please request a new code." };
  }
  
  const user = await db.select()
    .from(users)
    .where(and(
      eq(users.phoneE164, phoneE164),
      eq(users.phoneVerified, true),
      eq(users.isActive, true)
    ))
    .limit(1);
  
  if (user.length === 0) {
    return { success: false, error: "No account found with this phone number" };
  }
  
  try {
    const client = getTwilioClient();
    const verification = await client.verify.v2.services(verifyServiceSid!)
      .verificationChecks
      .create({ to: phoneE164, code });
    
    if (verification.status === "approved") {
      const resetToken = await createResetToken({
        userId: user[0].id,
        phoneE164,
        type: "user_password_reset",
      });
      
      await logOtpEvent({
        userId: user[0].id,
        phoneE164,
        eventType: "verify_success",
        ipAddress,
        userAgent,
        success: true,
      });
      
      return { success: true, userId: user[0].id, resetToken };
    } else {
      await logOtpEvent({
        userId: user[0].id,
        phoneE164,
        eventType: "verify_fail",
        ipAddress,
        userAgent,
        success: false,
        failReason: "invalid_code",
      });
      return { success: false, error: "Invalid verification code" };
    }
  } catch (error: any) {
    console.error("[Twilio] Failed to verify OTP:", error.message);
    await logOtpEvent({
      userId: user[0].id,
      phoneE164,
      eventType: "verify_fail",
      ipAddress,
      userAgent,
      success: false,
      failReason: error.message || "verification_error",
    });
    return { success: false, error: "Verification failed. Please try again." };
  }
}

export async function sendPhoneVerificationOtp(
  phoneE164: string,
  userId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const phoneRateLimit = await checkRateLimit(`verify:phone:${phoneE164}`, MAX_OTP_REQUESTS_PER_PHONE);
  if (!phoneRateLimit.allowed) {
    return { success: false, error: "Too many verification requests. Please try again later." };
  }
  
  try {
    const client = getTwilioClient();
    await client.verify.v2.services(verifyServiceSid!)
      .verifications
      .create({ to: phoneE164, channel: "sms" });
    
    await logOtpEvent({
      userId,
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: true,
    });
    
    return { success: true };
  } catch (error: any) {
    console.error("[Twilio] Failed to send verification OTP:", error.message);
    return { success: false, error: "Failed to send verification code. Please try again." };
  }
}

export async function verifyPhoneOtp(
  phoneE164: string,
  code: string,
  userId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const verifyRateLimit = await checkRateLimit(`phone_verify:${phoneE164}`, MAX_OTP_VERIFY_ATTEMPTS_PER_PHONE);
  if (!verifyRateLimit.allowed) {
    await logOtpEvent({
      userId,
      phoneE164,
      eventType: "verify_fail",
      ipAddress,
      userAgent,
      success: false,
      failReason: "verify_rate_limited",
    });
    return { success: false, error: "Too many verification attempts. Please request a new code." };
  }
  
  try {
    const client = getTwilioClient();
    const verification = await client.verify.v2.services(verifyServiceSid!)
      .verificationChecks
      .create({ to: phoneE164, code });
    
    if (verification.status === "approved") {
      await db.update(users)
        .set({
          phoneVerified: true,
          phoneVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      
      await logOtpEvent({
        userId,
        phoneE164,
        eventType: "verify_success",
        ipAddress,
        userAgent,
        success: true,
      });
      
      return { success: true };
    } else {
      await logOtpEvent({
        userId,
        phoneE164,
        eventType: "verify_fail",
        ipAddress,
        userAgent,
        success: false,
        failReason: "invalid_code",
      });
      return { success: false, error: "Invalid verification code" };
    }
  } catch (error: any) {
    console.error("[Twilio] Failed to verify phone OTP:", error.message);
    return { success: false, error: "Verification failed. Please try again." };
  }
}

export async function validateResetToken(resetToken: string): Promise<{ valid: boolean; userId?: string; phoneE164?: string; error?: string }> {
  const verification = await validateResetTokenInternal(resetToken);
  
  if (!verification.valid || !verification.data) {
    return { valid: false, error: verification.error || "Invalid token" };
  }
  
  const { userId, phoneE164, type } = verification.data;
  
  if (!userId || type !== "user_password_reset") {
    return { valid: false, error: "Invalid token type" };
  }
  
  const user = await db.select()
    .from(users)
    .where(and(
      eq(users.id, userId),
      eq(users.isActive, true)
    ))
    .limit(1);
  
  if (user.length === 0) {
    return { valid: false, error: "User not found" };
  }
  
  return { valid: true, userId, phoneE164 };
}

export async function validateAdvisorResetToken(resetToken: string): Promise<{ valid: boolean; personId?: string; phoneE164?: string; error?: string }> {
  const verification = await validateResetTokenInternal(resetToken);
  
  if (!verification.valid || !verification.data) {
    return { valid: false, error: verification.error || "Invalid token" };
  }
  
  const { personId, phoneE164, type } = verification.data;
  
  if (!personId || type !== "password_reset") {
    return { valid: false, error: "Invalid token type" };
  }
  
  const person = await db.select()
    .from(people)
    .where(and(
      eq(people.id, personId),
      eq(people.isActive, true),
      eq(people.personType, "ADVISOR")
    ))
    .limit(1);
  
  if (person.length === 0) {
    return { valid: false, error: "Advisor not found" };
  }
  
  return { valid: true, personId, phoneE164 };
}

export async function sendAdvisorPasswordResetOtp(
  phoneE164: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string; personId?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const phoneRateLimit = await checkRateLimit(`otp:phone:${phoneE164}`, MAX_OTP_REQUESTS_PER_PHONE);
  if (!phoneRateLimit.allowed) {
    return { success: false, error: "Too many OTP requests. Please try again later." };
  }
  
  const person = await db.select()
    .from(people)
    .where(and(
      eq(people.phoneE164, phoneE164),
      eq(people.phoneVerified, true),
      eq(people.isActive, true),
      eq(people.personType, "ADVISOR")
    ))
    .limit(1);
  
  if (person.length === 0) {
    await logOtpEvent({
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: false,
      failReason: "advisor_phone_not_found_or_unverified",
    });
    return { success: false, error: "No advisor account found with this verified phone number" };
  }
  
  try {
    const client = getTwilioClient();
    await client.verify.v2.services(verifyServiceSid!)
      .verifications
      .create({ to: phoneE164, channel: "sms" });
    
    await logOtpEvent({
      phoneE164,
      eventType: "request",
      ipAddress,
      userAgent,
      success: true,
    });
    
    return { success: true, personId: person[0].id };
  } catch (error: any) {
    console.error("[Twilio] Failed to send advisor OTP:", error.message);
    return { success: false, error: "Failed to send verification code. Please try again." };
  }
}

export async function verifyAdvisorPasswordResetOtp(
  phoneE164: string,
  code: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; error?: string; personId?: string; resetToken?: string }> {
  if (!isTwilioConfigured()) {
    return { success: false, error: "SMS service not configured" };
  }
  
  const verifyRateLimit = await checkRateLimit(`verify:advisor:${phoneE164}`, MAX_OTP_VERIFY_ATTEMPTS_PER_PHONE);
  if (!verifyRateLimit.allowed) {
    await logOtpEvent({
      phoneE164,
      eventType: "verify_fail",
      ipAddress,
      userAgent,
      success: false,
      failReason: "verify_rate_limited",
    });
    return { success: false, error: "Too many verification attempts. Please request a new code." };
  }
  
  const person = await db.select()
    .from(people)
    .where(and(
      eq(people.phoneE164, phoneE164),
      eq(people.phoneVerified, true),
      eq(people.isActive, true),
      eq(people.personType, "ADVISOR")
    ))
    .limit(1);
  
  if (person.length === 0) {
    return { success: false, error: "No advisor account found with this phone number" };
  }
  
  try {
    const client = getTwilioClient();
    const verification = await client.verify.v2.services(verifyServiceSid!)
      .verificationChecks
      .create({ to: phoneE164, code });
    
    if (verification.status === "approved") {
      const resetToken = await createResetToken({
        personId: person[0].id,
        type: "password_reset",
        phoneE164,
      });
      
      await logOtpEvent({
        phoneE164,
        eventType: "verify_success",
        ipAddress,
        userAgent,
        success: true,
      });
      
      return { success: true, personId: person[0].id, resetToken };
    } else {
      await logOtpEvent({
        phoneE164,
        eventType: "verify_fail",
        ipAddress,
        userAgent,
        success: false,
        failReason: "invalid_code",
      });
      return { success: false, error: "Invalid verification code" };
    }
  } catch (error: any) {
    console.error("[Twilio] Failed to verify advisor OTP:", error.message);
    return { success: false, error: "Verification failed. Please try again." };
  }
}

export async function cleanupExpiredRateLimits(): Promise<number> {
  const result = await db.delete(authRateLimits)
    .where(sql`${authRateLimits.expiresAt} < NOW()`)
    .returning({ id: authRateLimits.id });
  return result.length;
}
