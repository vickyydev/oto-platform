export type ParentExperienceLanguage = "en" | "th" | "ru" | "zh";

export const SUPPORTED_LANGUAGES: ParentExperienceLanguage[] = ["en", "th", "ru", "zh"];

export const LANGUAGE_NAMES: Record<ParentExperienceLanguage, string> = {
  en: "English",
  th: "ไทย",
  ru: "Русский",
  zh: "中文",
};

export const LANGUAGE_CODES: Record<ParentExperienceLanguage, string> = {
  en: "EN",
  th: "TH",
  ru: "RU",
  zh: "ZH",
};

type TranslationKey =
  | "invitation.title"
  | "invitation.youAreInvited"
  | "invitation.birthday"
  | "invitation.date"
  | "invitation.time"
  | "invitation.location"
  | "invitation.viewMap"
  | "invitation.rsvpTitle"
  | "invitation.rsvpSubtitle"
  | "invitation.notFound"
  | "invitation.notFoundMessage"
  | "rsvp.guestName"
  | "rsvp.phone"
  | "rsvp.willAttend"
  | "rsvp.attending.yes"
  | "rsvp.attending.no"
  | "rsvp.attending.maybe"
  | "rsvp.numberOfKids"
  | "rsvp.numberOfAdults"
  | "rsvp.notes"
  | "rsvp.notesPlaceholder"
  | "rsvp.submit"
  | "rsvp.success"
  | "rsvp.successMessage"
  | "rsvp.alreadySubmitted"
  | "rsvp.alreadySubmittedMessage"
  | "rsvp.noRsvpYet"
  | "portal.partyPlan"
  | "portal.invitations"
  | "portal.rsvpDashboard"
  | "portal.guestList"
  | "portal.confirmedGuests"
  | "portal.totalKids"
  | "portal.totalAdults"
  | "portal.pendingResponses"
  | "portal.declined"
  | "portal.downloadInvitation"
  | "portal.shareViaWhatsApp"
  | "portal.copyLink"
  | "portal.eventDetails"
  | "portal.viewFullSchedule"
  | "portal.accessDenied"
  | "portal.accessDeniedMessage"
  | "message.whatsappGreeting"
  | "message.whatsappInviteIntro"
  | "message.whatsappRsvpPrompt"
  | "message.whatsappThankYou"
  | "common.loading"
  | "common.error"
  | "common.save"
  | "common.cancel"
  | "common.back"
  | "common.next"
  | "common.close"
  | "wizard.createInvitation"
  | "wizard.stepTemplate"
  | "wizard.stepPhotoText"
  | "wizard.stepGenerate"
  | "wizard.selectTemplate"
  | "wizard.uploadPhoto"
  | "wizard.uploadPhotoHint"
  | "wizard.shortMessage"
  | "wizard.shortMessagePlaceholder"
  | "wizard.charactersRemaining"
  | "wizard.generateInvitation"
  | "wizard.generating"
  | "wizard.downloadJpg"
  | "wizard.copyRsvpLink"
  | "wizard.shareWhatsApp"
  | "wizard.shareTelegram"
  | "wizard.rsvpLinkWarning"
  | "wizard.invitationReady"
  | "wizard.notCreatedYet"
  | "wizard.viewRegenerate"
  | "portal.createInvitation"
  | "portal.accepted"
  | "portal.maybe";

const translations: Record<ParentExperienceLanguage, Record<TranslationKey, string>> = {
  en: {
    "invitation.title": "Birthday Party Invitation",
    "invitation.youAreInvited": "You're Invited!",
    "invitation.birthday": "{name}'s {age} Birthday",
    "invitation.date": "Date",
    "invitation.time": "Time",
    "invitation.location": "Location",
    "invitation.viewMap": "View on Map",
    "invitation.rsvpTitle": "RSVP",
    "invitation.rsvpSubtitle": "Please let us know if you can make it",
    "invitation.notFound": "Invitation Not Found",
    "invitation.notFoundMessage": "This invitation link is invalid or has expired.",
    "rsvp.guestName": "Your Name",
    "rsvp.phone": "Phone Number",
    "rsvp.willAttend": "Will you attend?",
    "rsvp.attending.yes": "Yes, we'll be there!",
    "rsvp.attending.no": "Sorry, we can't make it",
    "rsvp.attending.maybe": "Maybe",
    "rsvp.numberOfKids": "Number of Kids",
    "rsvp.numberOfAdults": "Number of Adults",
    "rsvp.notes": "Any special requests or notes",
    "rsvp.notesPlaceholder": "Enter any dietary requirements, allergies, or special requests...",
    "rsvp.noRsvpYet": "No responses yet",
    "rsvp.submit": "Submit RSVP",
    "rsvp.success": "Thank You!",
    "rsvp.successMessage": "Your RSVP has been submitted successfully",
    "rsvp.alreadySubmitted": "Already Responded",
    "rsvp.alreadySubmittedMessage": "You have already submitted your RSVP for this event",
    "portal.partyPlan": "Party Plan",
    "portal.invitations": "Invitations",
    "portal.rsvpDashboard": "RSVP Dashboard",
    "portal.guestList": "Guest List",
    "portal.confirmedGuests": "Confirmed Guests",
    "portal.totalKids": "Total Kids",
    "portal.totalAdults": "Total Adults",
    "portal.pendingResponses": "Pending Responses",
    "portal.declined": "Declined",
    "portal.downloadInvitation": "Download Invitation",
    "portal.shareViaWhatsApp": "Share via WhatsApp",
    "portal.copyLink": "Copy Link",
    "portal.eventDetails": "Event Details",
    "portal.viewFullSchedule": "View Full Schedule",
    "portal.accessDenied": "Access Denied",
    "portal.accessDeniedMessage": "This portal link is invalid or has been revoked.",
    "message.whatsappGreeting": "Hello!",
    "message.whatsappInviteIntro": "You're invited to {childName}'s birthday party!",
    "message.whatsappRsvpPrompt": "Please click the link below to RSVP:",
    "message.whatsappThankYou": "We hope to see you there!",
    "common.loading": "Loading...",
    "common.error": "An error occurred",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.back": "Back",
    "common.next": "Next",
    "common.close": "Close",
    "wizard.createInvitation": "Create Invitation",
    "wizard.stepTemplate": "Template",
    "wizard.stepPhotoText": "Photo & Text",
    "wizard.stepGenerate": "Generate & Share",
    "wizard.selectTemplate": "Select a Template",
    "wizard.uploadPhoto": "Upload Child Photo",
    "wizard.uploadPhotoHint": "Upload a photo of the birthday child",
    "wizard.shortMessage": "Short Message (max 30 characters)",
    "wizard.shortMessagePlaceholder": "Come celebrate with us!",
    "wizard.charactersRemaining": "{count} characters remaining",
    "wizard.generateInvitation": "Generate Invitation",
    "wizard.generating": "Generating...",
    "wizard.downloadJpg": "Download JPG",
    "wizard.copyRsvpLink": "Copy RSVP Link",
    "wizard.shareWhatsApp": "Share on WhatsApp",
    "wizard.shareTelegram": "Share on Telegram",
    "wizard.rsvpLinkWarning": "Share this link with guests to RSVP.",
    "wizard.invitationReady": "Your Invitation is Ready!",
    "wizard.notCreatedYet": "Not created yet",
    "wizard.viewRegenerate": "View / Regenerate",
    "portal.createInvitation": "Create Invitation",
    "portal.accepted": "Accepted",
    "portal.maybe": "Maybe",
  },
  th: {
    "invitation.title": "บัตรเชิญงานวันเกิด",
    "invitation.youAreInvited": "ขอเชิญร่วมงาน!",
    "invitation.birthday": "งานวันเกิด{name} อายุ {age} ปี",
    "invitation.date": "วันที่",
    "invitation.time": "เวลา",
    "invitation.location": "สถานที่",
    "invitation.viewMap": "ดูแผนที่",
    "invitation.rsvpTitle": "ตอบรับ",
    "invitation.rsvpSubtitle": "กรุณาแจ้งให้เราทราบว่าคุณจะมาร่วมงานได้หรือไม่",
    "invitation.notFound": "ไม่พบบัตรเชิญ",
    "invitation.notFoundMessage": "ลิงก์บัตรเชิญนี้ไม่ถูกต้องหรือหมดอายุแล้ว",
    "rsvp.guestName": "ชื่อของคุณ",
    "rsvp.phone": "เบอร์โทรศัพท์",
    "rsvp.willAttend": "คุณจะมาร่วมงานไหม?",
    "rsvp.attending.yes": "ไปแน่นอน!",
    "rsvp.attending.no": "ขอโทษ ไปไม่ได้",
    "rsvp.attending.maybe": "ยังไม่แน่ใจ",
    "rsvp.numberOfKids": "จำนวนเด็ก",
    "rsvp.numberOfAdults": "จำนวนผู้ใหญ่",
    "rsvp.notes": "คำขอพิเศษหรือหมายเหตุ",
    "rsvp.notesPlaceholder": "กรุณาระบุข้อจำกัดด้านอาหาร อาการแพ้ หรือคำขอพิเศษ...",
    "rsvp.noRsvpYet": "ยังไม่มีการตอบรับ",
    "rsvp.submit": "ส่งการตอบรับ",
    "rsvp.success": "ขอบคุณ!",
    "rsvp.successMessage": "การตอบรับของคุณได้รับการบันทึกแล้ว",
    "rsvp.alreadySubmitted": "ตอบรับแล้ว",
    "rsvp.alreadySubmittedMessage": "คุณได้ส่งการตอบรับสำหรับงานนี้แล้ว",
    "portal.partyPlan": "แผนงานปาร์ตี้",
    "portal.invitations": "บัตรเชิญ",
    "portal.rsvpDashboard": "แดชบอร์ดการตอบรับ",
    "portal.guestList": "รายชื่อแขก",
    "portal.confirmedGuests": "แขกที่ยืนยัน",
    "portal.totalKids": "จำนวนเด็กทั้งหมด",
    "portal.totalAdults": "จำนวนผู้ใหญ่ทั้งหมด",
    "portal.pendingResponses": "รอการตอบรับ",
    "portal.declined": "ปฏิเสธ",
    "portal.downloadInvitation": "ดาวน์โหลดบัตรเชิญ",
    "portal.shareViaWhatsApp": "แชร์ผ่าน WhatsApp",
    "portal.copyLink": "คัดลอกลิงก์",
    "portal.eventDetails": "รายละเอียดงาน",
    "portal.viewFullSchedule": "ดูตารางเวลาทั้งหมด",
    "portal.accessDenied": "ไม่สามารถเข้าถึงได้",
    "portal.accessDeniedMessage": "ลิงก์พอร์ทัลนี้ไม่ถูกต้องหรือถูกยกเลิกแล้ว",
    "message.whatsappGreeting": "Hello!",
    "message.whatsappInviteIntro": "You are invited to {childName}'s birthday party!",
    "message.whatsappRsvpPrompt": "Please click the link below to RSVP:",
    "message.whatsappThankYou": "We hope to see you there!",
    "common.loading": "กำลังโหลด...",
    "common.error": "เกิดข้อผิดพลาด",
    "common.save": "บันทึก",
    "common.cancel": "ยกเลิก",
    "common.back": "กลับ",
    "common.next": "ถัดไป",
    "common.close": "ปิด",
    "wizard.createInvitation": "สร้างบัตรเชิญ",
    "wizard.stepTemplate": "เทมเพลต",
    "wizard.stepPhotoText": "รูปภาพและข้อความ",
    "wizard.stepGenerate": "สร้างและแชร์",
    "wizard.selectTemplate": "เลือกเทมเพลต",
    "wizard.uploadPhoto": "อัพโหลดรูปเด็ก",
    "wizard.uploadPhotoHint": "อัพโหลดรูปของเด็กที่จะจัดงานวันเกิด",
    "wizard.shortMessage": "ข้อความสั้น (สูงสุด 30 ตัวอักษร)",
    "wizard.shortMessagePlaceholder": "มาร่วมฉลองกับเรา!",
    "wizard.charactersRemaining": "เหลือ {count} ตัวอักษร",
    "wizard.generateInvitation": "สร้างบัตรเชิญ",
    "wizard.generating": "กำลังสร้าง...",
    "wizard.downloadJpg": "ดาวน์โหลด JPG",
    "wizard.copyRsvpLink": "คัดลอกลิงก์ RSVP",
    "wizard.shareWhatsApp": "แชร์ผ่าน WhatsApp",
    "wizard.shareTelegram": "แชร์ผ่าน Telegram",
    "wizard.rsvpLinkWarning": "แชร์ลิงก์นี้ให้แขกเพื่อตอบรับ",
    "wizard.invitationReady": "บัตรเชิญของคุณพร้อมแล้ว!",
    "wizard.notCreatedYet": "ยังไม่ได้สร้าง",
    "wizard.viewRegenerate": "ดู / สร้างใหม่",
    "portal.createInvitation": "สร้างบัตรเชิญ",
    "portal.accepted": "ตอบรับ",
    "portal.maybe": "ยังไม่แน่ใจ",
  },
  ru: {
    "invitation.title": "Приглашение на День Рождения",
    "invitation.youAreInvited": "Вы приглашены!",
    "invitation.birthday": "День Рождения {name} - {age} лет",
    "invitation.date": "Дата",
    "invitation.time": "Время",
    "invitation.location": "Место",
    "invitation.viewMap": "Открыть карту",
    "invitation.rsvpTitle": "Подтверждение",
    "invitation.rsvpSubtitle": "Пожалуйста, сообщите нам, сможете ли вы прийти",
    "invitation.notFound": "Приглашение не найдено",
    "invitation.notFoundMessage": "Эта ссылка на приглашение недействительна или истекла.",
    "rsvp.guestName": "Ваше имя",
    "rsvp.phone": "Номер телефона",
    "rsvp.willAttend": "Вы придёте?",
    "rsvp.attending.yes": "Да, мы будем!",
    "rsvp.attending.no": "К сожалению, не сможем",
    "rsvp.attending.maybe": "Возможно",
    "rsvp.numberOfKids": "Количество детей",
    "rsvp.numberOfAdults": "Количество взрослых",
    "rsvp.notes": "Особые пожелания или заметки",
    "rsvp.notesPlaceholder": "Укажите диетические требования, аллергии или особые пожелания...",
    "rsvp.noRsvpYet": "Пока нет ответов",
    "rsvp.submit": "Отправить ответ",
    "rsvp.success": "Спасибо!",
    "rsvp.successMessage": "Ваш ответ успешно отправлен",
    "rsvp.alreadySubmitted": "Уже отвечено",
    "rsvp.alreadySubmittedMessage": "Вы уже отправили ответ на это мероприятие",
    "portal.partyPlan": "План праздника",
    "portal.invitations": "Приглашения",
    "portal.rsvpDashboard": "Панель ответов",
    "portal.guestList": "Список гостей",
    "portal.confirmedGuests": "Подтверждённые гости",
    "portal.totalKids": "Всего детей",
    "portal.totalAdults": "Всего взрослых",
    "portal.pendingResponses": "Ожидают ответа",
    "portal.declined": "Отказались",
    "portal.downloadInvitation": "Скачать приглашение",
    "portal.shareViaWhatsApp": "Поделиться в WhatsApp",
    "portal.copyLink": "Копировать ссылку",
    "portal.eventDetails": "Детали мероприятия",
    "portal.viewFullSchedule": "Посмотреть расписание",
    "portal.accessDenied": "Доступ запрещён",
    "portal.accessDeniedMessage": "Эта ссылка на портал недействительна или была отозвана.",
    "message.whatsappGreeting": "Hello!",
    "message.whatsappInviteIntro": "You are invited to {childName}'s birthday party!",
    "message.whatsappRsvpPrompt": "Please click the link below to RSVP:",
    "message.whatsappThankYou": "We hope to see you there!",
    "common.loading": "Загрузка...",
    "common.error": "Произошла ошибка",
    "common.save": "Сохранить",
    "common.cancel": "Отмена",
    "common.back": "Назад",
    "common.next": "Далее",
    "common.close": "Закрыть",
    "wizard.createInvitation": "Создать приглашение",
    "wizard.stepTemplate": "Шаблон",
    "wizard.stepPhotoText": "Фото и текст",
    "wizard.stepGenerate": "Создать и поделиться",
    "wizard.selectTemplate": "Выберите шаблон",
    "wizard.uploadPhoto": "Загрузить фото ребёнка",
    "wizard.uploadPhotoHint": "Загрузите фото именинника",
    "wizard.shortMessage": "Короткое сообщение (макс. 30 символов)",
    "wizard.shortMessagePlaceholder": "Приходите отпраздновать с нами!",
    "wizard.charactersRemaining": "Осталось {count} символов",
    "wizard.generateInvitation": "Создать приглашение",
    "wizard.generating": "Создание...",
    "wizard.downloadJpg": "Скачать JPG",
    "wizard.copyRsvpLink": "Копировать ссылку RSVP",
    "wizard.shareWhatsApp": "Поделиться в WhatsApp",
    "wizard.shareTelegram": "Поделиться в Telegram",
    "wizard.rsvpLinkWarning": "Поделитесь этой ссылкой с гостями для подтверждения.",
    "wizard.invitationReady": "Ваше приглашение готово!",
    "wizard.notCreatedYet": "Ещё не создано",
    "wizard.viewRegenerate": "Просмотр / Пересоздать",
    "portal.createInvitation": "Создать приглашение",
    "portal.accepted": "Приняли",
    "portal.maybe": "Возможно",
  },
  zh: {
    "invitation.title": "生日派对邀请函",
    "invitation.youAreInvited": "诚邀您参加！",
    "invitation.birthday": "{name}的{age}岁生日",
    "invitation.date": "日期",
    "invitation.time": "时间",
    "invitation.location": "地点",
    "invitation.viewMap": "查看地图",
    "invitation.rsvpTitle": "回复确认",
    "invitation.rsvpSubtitle": "请告诉我们您是否能来",
    "invitation.notFound": "未找到邀请函",
    "invitation.notFoundMessage": "此邀请链接无效或已过期。",
    "rsvp.guestName": "您的姓名",
    "rsvp.phone": "电话号码",
    "rsvp.willAttend": "您会出席吗？",
    "rsvp.attending.yes": "是的，我们会去！",
    "rsvp.attending.no": "抱歉，我们无法参加",
    "rsvp.attending.maybe": "也许",
    "rsvp.numberOfKids": "儿童人数",
    "rsvp.numberOfAdults": "成人人数",
    "rsvp.notes": "特殊要求或备注",
    "rsvp.notesPlaceholder": "请输入饮食要求、过敏情况或特殊需求...",
    "rsvp.noRsvpYet": "暂无回复",
    "rsvp.submit": "提交回复",
    "rsvp.success": "谢谢！",
    "rsvp.successMessage": "您的回复已成功提交",
    "rsvp.alreadySubmitted": "已经回复",
    "rsvp.alreadySubmittedMessage": "您已经提交过此活动的回复",
    "portal.partyPlan": "派对计划",
    "portal.invitations": "邀请函",
    "portal.rsvpDashboard": "回复仪表板",
    "portal.guestList": "宾客名单",
    "portal.confirmedGuests": "已确认宾客",
    "portal.totalKids": "儿童总数",
    "portal.totalAdults": "成人总数",
    "portal.pendingResponses": "待回复",
    "portal.declined": "已婉拒",
    "portal.downloadInvitation": "下载邀请函",
    "portal.shareViaWhatsApp": "通过WhatsApp分享",
    "portal.copyLink": "复制链接",
    "portal.eventDetails": "活动详情",
    "portal.viewFullSchedule": "查看完整日程",
    "portal.accessDenied": "访问被拒绝",
    "portal.accessDeniedMessage": "此门户链接无效或已被撤销。",
    "message.whatsappGreeting": "Hello!",
    "message.whatsappInviteIntro": "You are invited to {childName}'s birthday party!",
    "message.whatsappRsvpPrompt": "Please click the link below to RSVP:",
    "message.whatsappThankYou": "We hope to see you there!",
    "common.loading": "加载中...",
    "common.error": "发生错误",
    "common.save": "保存",
    "common.cancel": "取消",
    "common.back": "返回",
    "common.next": "下一步",
    "common.close": "关闭",
    "wizard.createInvitation": "创建邀请函",
    "wizard.stepTemplate": "模板",
    "wizard.stepPhotoText": "照片和文字",
    "wizard.stepGenerate": "生成和分享",
    "wizard.selectTemplate": "选择模板",
    "wizard.uploadPhoto": "上传儿童照片",
    "wizard.uploadPhotoHint": "上传生日宝宝的照片",
    "wizard.shortMessage": "简短消息（最多30个字符）",
    "wizard.shortMessagePlaceholder": "来和我们一起庆祝吧！",
    "wizard.charactersRemaining": "还剩 {count} 个字符",
    "wizard.generateInvitation": "生成邀请函",
    "wizard.generating": "生成中...",
    "wizard.downloadJpg": "下载 JPG",
    "wizard.copyRsvpLink": "复制回复链接",
    "wizard.shareWhatsApp": "分享到 WhatsApp",
    "wizard.shareTelegram": "分享到 Telegram",
    "wizard.rsvpLinkWarning": "将此链接分享给宾客以便回复。",
    "wizard.invitationReady": "您的邀请函已准备好！",
    "wizard.notCreatedYet": "尚未创建",
    "wizard.viewRegenerate": "查看 / 重新生成",
    "portal.createInvitation": "创建邀请函",
    "portal.accepted": "已接受",
    "portal.maybe": "也许",
  },
};

export function t(key: TranslationKey, lang: ParentExperienceLanguage = "en", params?: Record<string, string>): string {
  let text = translations[lang]?.[key] || translations.en[key] || key;
  
  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(new RegExp(`\\{${paramKey}\\}`, "g"), value);
    });
  }
  
  return text;
}

export function formatDateForLanguage(date: Date, lang: ParentExperienceLanguage): string {
  const localeMap: Record<ParentExperienceLanguage, string> = {
    en: "en-US",
    th: "th-TH",
    ru: "ru-RU",
    zh: "zh-CN",
  };
  
  return new Intl.DateTimeFormat(localeMap[lang], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatTimeForLanguage(time: string, lang: ParentExperienceLanguage): string {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes);
  
  const localeMap: Record<ParentExperienceLanguage, string> = {
    en: "en-US",
    th: "th-TH",
    ru: "ru-RU",
    zh: "zh-CN",
  };
  
  return new Intl.DateTimeFormat(localeMap[lang], {
    hour: "numeric",
    minute: "2-digit",
    hour12: lang === "en",
  }).format(date);
}

export function generateWhatsAppMessage(
  lang: ParentExperienceLanguage,
  childName: string,
  rsvpLink: string
): string {
  const greeting = t("message.whatsappGreeting", lang);
  const intro = t("message.whatsappInviteIntro", lang, { childName });
  const prompt = t("message.whatsappRsvpPrompt", lang);
  const thanks = t("message.whatsappThankYou", lang);
  
  return `${greeting}\n\n${intro}\n\n${prompt}\n${rsvpLink}\n\n${thanks}`;
}

export interface InvitationTemplate {
  id: string;
  name: string;
  previewImageUrl: string;
  backgroundColor: string;
  accentColor: string;
}

export const INVITATION_TEMPLATES: InvitationTemplate[] = [
  {
    id: "enchanted_castle",
    name: "Enchanted Castle",
    previewImageUrl: "/api/invitation-templates/enchanted_castle/preview.jpg",
    backgroundColor: "#FFE4EC",
    accentColor: "#FF6B9D",
  },
  {
    id: "space_adventure",
    name: "Space Adventure",
    previewImageUrl: "/api/invitation-templates/space_adventure/preview.jpg",
    backgroundColor: "#1A1A2E",
    accentColor: "#4FC3F7",
  },
  {
    id: "candy_wonderland",
    name: "Candy Wonderland",
    previewImageUrl: "/api/invitation-templates/candy_wonderland/preview.jpg",
    backgroundColor: "#FFF5E6",
    accentColor: "#FF9F43",
  },
  {
    id: "jungle_quest",
    name: "Jungle Quest",
    previewImageUrl: "/api/invitation-templates/jungle_quest/preview.jpg",
    backgroundColor: "#E8F5E9",
    accentColor: "#4CAF50",
  },
  {
    id: "ocean_magic",
    name: "Ocean Magic",
    previewImageUrl: "/api/invitation-templates/ocean_magic/preview.jpg",
    backgroundColor: "#E0F7FA",
    accentColor: "#00BCD4",
  },
];

export function getOrdinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function generateSecureToken(length: number = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  const randomValues = new Uint32Array(length);
  
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      token += chars[randomValues[i] % chars.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  
  return token;
}
