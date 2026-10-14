import nodemailer from "nodemailer";
import path from "path";

interface EmailOptions {
  to: string;
  subject: string;
  body: string;
  attachmentPath?: string;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** True when no mail server is configured: nothing was attempted. */
  notConfigured?: boolean;
}

export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const { to, subject, body, attachmentPath } = options;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || "587");
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const fromEmail = process.env.EMAIL_FROM || "noreply@company.com";

  if (!smtpHost || !smtpUser || !smtpPass) {
    // Nothing is sent without a mail server; say so instead of reporting a
    // simulated success the caller would record as "sent".
    console.log("Email not sent: SMTP is not configured on this server");
    return {
      success: false,
      notConfigured: true,
      error: "Email isn't set up on this server, so nothing was sent.",
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const mailOptions: nodemailer.SendMailOptions = {
      from: fromEmail,
      to,
      subject,
      text: body,
    };

    if (attachmentPath) {
      mailOptions.attachments = [
        {
          filename: path.basename(attachmentPath),
          path: attachmentPath,
        },
      ];
    }

    const info = await transporter.sendMail(mailOptions);

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    console.error("Email sending failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}
