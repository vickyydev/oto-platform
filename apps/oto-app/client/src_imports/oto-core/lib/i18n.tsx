import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type Language = "en" | "ru" | "th";

const translations = {
  en: {
    // Navigation
    nav: {
      today: "Today",
      learn: "Learn",
      find: "Find",
      fix: "Issues",
      events: "Events",
      checkins: "Check-ins",
      dashboard: "Dashboard",
      admin: "Admin",
    },
    // Common
    common: {
      loading: "Loading...",
      save: "Save",
      cancel: "Cancel",
      delete: "Delete",
      edit: "Edit",
      create: "Create",
      search: "Search",
      filter: "Filter",
      back: "Back",
      next: "Next",
      submit: "Submit",
      confirm: "Confirm",
      close: "Close",
      viewAll: "View all",
      noResults: "No results found",
      error: "Error",
      success: "Success",
      warning: "Warning",
      today: "Today",
      upcoming: "Upcoming",
      past: "Past",
      all: "All",
      more: "More",
    },
    // Today page
    today: {
      title: "Today",
      checklists: "Checklists",
      noChecklists: "No checklists",
      noChecklistsDesc: "There are no checklists assigned for today.",
      quickActions: "Quick Actions",
      reportIssue: "Report Issue",
      escalate: "Escalate",
      start: "Start",
      continue: "Continue",
      view: "View",
      dueBy: "Due by",
      createChecklist: "Create Checklist",
      eventsToday: "Events Today",
      noEventsToday: "No events scheduled for today",
    },
    // Events
    events: {
      title: "Events",
      eventDetails: "Event Details",
      birthday: "Birthday",
      privateEvent: "Private Event",
      schoolGroup: "School Group",
      other: "Other",
      children: "Children",
      adults: "Adults",
      program: "Program",
      allergies: "Allergies",
      cake: "Cake",
      specialRequests: "Special Requests",
      contact: "Contact",
      whatsapp: "WhatsApp",
      messageParent: "Message Parent",
      status: {
        upcoming: "Upcoming",
        inProgress: "In Progress",
        completed: "Completed",
        cancelled: "Cancelled",
      },
      createEvent: "Create Event",
      editEvent: "Edit Event",
      noEvents: "No events",
      noEventsDesc: "No events scheduled.",
      calendar: "Calendar",
      list: "List",
    },
    // Auth
    auth: {
      login: "Login",
      logout: "Logout",
      email: "Email",
      password: "Password",
      signIn: "Sign In",
      signingIn: "Signing in...",
    },
    // Learn
    learn: {
      title: "Learn",
      modules: "Training Modules",
      startQuiz: "Start Quiz",
      continueReading: "Continue Reading",
      completed: "Completed",
      passRate: "Pass rate: 70%",
    },
    // Find (SOPs)
    find: {
      title: "Find",
      searchSOPs: "Search SOPs...",
      categories: "Categories",
      recentlyViewed: "Recently Viewed",
    },
    // Fix (Troubleshooting)
    fix: {
      title: "Fix",
      troubleshooting: "Troubleshooting",
      selectIssue: "Select an issue to troubleshoot",
    },
    // Check-ins
    checkins: {
      title: "Check-ins",
      active: "Active",
      history: "History",
      checkIn: "Check In",
      checkOut: "Check Out",
      nanny: "Nanny Service",
      dropoff: "Drop-Off Service",
      childName: "Child Name",
      parentName: "Parent Name",
      age: "Age",
    },
    // Settings
    settings: {
      title: "Settings",
      language: "Language",
      theme: "Theme",
      darkMode: "Dark Mode",
      lightMode: "Light Mode",
      system: "System",
    },
    // Languages
    languages: {
      en: "English",
      ru: "Русский",
      th: "ไทย",
    },
  },
  ru: {
    // Navigation
    nav: {
      today: "Сегодня",
      learn: "Обучение",
      find: "Поиск",
      fix: "Проблемы",
      events: "События",
      checkins: "Регистрация",
      dashboard: "Панель",
      admin: "Админ",
    },
    // Common
    common: {
      loading: "Загрузка...",
      save: "Сохранить",
      cancel: "Отмена",
      delete: "Удалить",
      edit: "Редактировать",
      create: "Создать",
      search: "Поиск",
      filter: "Фильтр",
      back: "Назад",
      next: "Далее",
      submit: "Отправить",
      confirm: "Подтвердить",
      close: "Закрыть",
      viewAll: "Смотреть все",
      noResults: "Результаты не найдены",
      error: "Ошибка",
      success: "Успешно",
      warning: "Предупреждение",
      today: "Сегодня",
      upcoming: "Предстоящие",
      past: "Прошедшие",
      all: "Все",
      more: "Ещё",
    },
    // Today page
    today: {
      title: "Сегодня",
      checklists: "Чек-листы",
      noChecklists: "Нет чек-листов",
      noChecklistsDesc: "На сегодня нет назначенных чек-листов.",
      quickActions: "Быстрые действия",
      reportIssue: "Сообщить о проблеме",
      escalate: "Эскалация",
      start: "Начать",
      continue: "Продолжить",
      view: "Просмотр",
      dueBy: "Срок до",
      createChecklist: "Создать чек-лист",
      eventsToday: "События сегодня",
      noEventsToday: "Сегодня нет запланированных событий",
    },
    // Events
    events: {
      title: "События",
      eventDetails: "Детали события",
      birthday: "День рождения",
      privateEvent: "Частное мероприятие",
      schoolGroup: "Школьная группа",
      other: "Другое",
      children: "Дети",
      adults: "Взрослые",
      program: "Программа",
      allergies: "Аллергии",
      cake: "Торт",
      specialRequests: "Особые пожелания",
      contact: "Контакт",
      whatsapp: "WhatsApp",
      messageParent: "Написать родителю",
      status: {
        upcoming: "Предстоящее",
        inProgress: "В процессе",
        completed: "Завершено",
        cancelled: "Отменено",
      },
      createEvent: "Создать событие",
      editEvent: "Редактировать событие",
      noEvents: "Нет событий",
      noEventsDesc: "Нет запланированных событий.",
      calendar: "Календарь",
      list: "Список",
    },
    // Auth
    auth: {
      login: "Вход",
      logout: "Выход",
      email: "Эл. почта",
      password: "Пароль",
      signIn: "Войти",
      signingIn: "Вход...",
    },
    // Learn
    learn: {
      title: "Обучение",
      modules: "Модули обучения",
      startQuiz: "Начать тест",
      continueReading: "Продолжить чтение",
      completed: "Завершено",
      passRate: "Проходной балл: 70%",
    },
    // Find (SOPs)
    find: {
      title: "Поиск",
      searchSOPs: "Поиск инструкций...",
      categories: "Категории",
      recentlyViewed: "Недавно просмотренные",
    },
    // Fix (Troubleshooting)
    fix: {
      title: "Решение",
      troubleshooting: "Устранение неполадок",
      selectIssue: "Выберите проблему для устранения",
    },
    // Check-ins
    checkins: {
      title: "Регистрация",
      active: "Активные",
      history: "История",
      checkIn: "Регистрация",
      checkOut: "Выписка",
      nanny: "Услуга няни",
      dropoff: "Услуга присмотра",
      childName: "Имя ребёнка",
      parentName: "Имя родителя",
      age: "Возраст",
    },
    // Settings
    settings: {
      title: "Настройки",
      language: "Язык",
      theme: "Тема",
      darkMode: "Тёмный режим",
      lightMode: "Светлый режим",
      system: "Системный",
    },
    // Languages
    languages: {
      en: "English",
      ru: "Русский",
      th: "ไทย",
    },
  },
  th: {
    // Navigation
    nav: {
      today: "วันนี้",
      learn: "เรียนรู้",
      find: "ค้นหา",
      fix: "ปัญหา",
      events: "กิจกรรม",
      checkins: "เช็คอิน",
      dashboard: "แดชบอร์ด",
      admin: "ผู้ดูแล",
    },
    // Common
    common: {
      loading: "กำลังโหลด...",
      save: "บันทึก",
      cancel: "ยกเลิก",
      delete: "ลบ",
      edit: "แก้ไข",
      create: "สร้าง",
      search: "ค้นหา",
      filter: "กรอง",
      back: "กลับ",
      next: "ถัดไป",
      submit: "ส่ง",
      confirm: "ยืนยัน",
      close: "ปิด",
      viewAll: "ดูทั้งหมด",
      noResults: "ไม่พบผลลัพธ์",
      error: "ข้อผิดพลาด",
      success: "สำเร็จ",
      warning: "คำเตือน",
      today: "วันนี้",
      upcoming: "กำลังจะมาถึง",
      past: "ผ่านมาแล้ว",
      all: "ทั้งหมด",
      more: "เพิ่มเติม",
    },
    // Today page
    today: {
      title: "วันนี้",
      checklists: "เช็คลิสต์",
      noChecklists: "ไม่มีเช็คลิสต์",
      noChecklistsDesc: "ไม่มีเช็คลิสต์ที่กำหนดสำหรับวันนี้",
      quickActions: "การดำเนินการด่วน",
      reportIssue: "รายงานปัญหา",
      escalate: "ยกระดับ",
      start: "เริ่ม",
      continue: "ดำเนินการต่อ",
      view: "ดู",
      dueBy: "ครบกำหนด",
      createChecklist: "สร้างเช็คลิสต์",
      eventsToday: "กิจกรรมวันนี้",
      noEventsToday: "ไม่มีกิจกรรมที่กำหนดสำหรับวันนี้",
    },
    // Events
    events: {
      title: "กิจกรรม",
      eventDetails: "รายละเอียดกิจกรรม",
      birthday: "วันเกิด",
      privateEvent: "งานส่วนตัว",
      schoolGroup: "กลุ่มโรงเรียน",
      other: "อื่นๆ",
      children: "เด็ก",
      adults: "ผู้ใหญ่",
      program: "โปรแกรม",
      allergies: "อาการแพ้",
      cake: "เค้ก",
      specialRequests: "ความต้องการพิเศษ",
      contact: "ติดต่อ",
      whatsapp: "WhatsApp",
      messageParent: "ส่งข้อความถึงผู้ปกครอง",
      status: {
        upcoming: "กำลังจะมาถึง",
        inProgress: "กำลังดำเนินการ",
        completed: "เสร็จสิ้น",
        cancelled: "ยกเลิก",
      },
      createEvent: "สร้างกิจกรรม",
      editEvent: "แก้ไขกิจกรรม",
      noEvents: "ไม่มีกิจกรรม",
      noEventsDesc: "ไม่มีกิจกรรมที่กำหนด",
      calendar: "ปฏิทิน",
      list: "รายการ",
    },
    // Auth
    auth: {
      login: "เข้าสู่ระบบ",
      logout: "ออกจากระบบ",
      email: "อีเมล",
      password: "รหัสผ่าน",
      signIn: "ลงชื่อเข้าใช้",
      signingIn: "กำลังลงชื่อ...",
    },
    // Learn
    learn: {
      title: "เรียนรู้",
      modules: "โมดูลการฝึกอบรม",
      startQuiz: "เริ่มแบบทดสอบ",
      continueReading: "อ่านต่อ",
      completed: "เสร็จสิ้น",
      passRate: "เกณฑ์ผ่าน: 70%",
    },
    // Find (SOPs)
    find: {
      title: "ค้นหา",
      searchSOPs: "ค้นหาคู่มือ...",
      categories: "หมวดหมู่",
      recentlyViewed: "ดูล่าสุด",
    },
    // Fix (Troubleshooting)
    fix: {
      title: "แก้ไข",
      troubleshooting: "การแก้ไขปัญหา",
      selectIssue: "เลือกปัญหาที่ต้องการแก้ไข",
    },
    // Check-ins
    checkins: {
      title: "เช็คอิน",
      active: "ใช้งานอยู่",
      history: "ประวัติ",
      checkIn: "เช็คอิน",
      checkOut: "เช็คเอาท์",
      nanny: "บริการพี่เลี้ยง",
      dropoff: "บริการฝากเด็ก",
      childName: "ชื่อเด็ก",
      parentName: "ชื่อผู้ปกครอง",
      age: "อายุ",
    },
    // Settings
    settings: {
      title: "การตั้งค่า",
      language: "ภาษา",
      theme: "ธีม",
      darkMode: "โหมดมืด",
      lightMode: "โหมดสว่าง",
      system: "ระบบ",
    },
    // Languages
    languages: {
      en: "English",
      ru: "Русский",
      th: "ไทย",
    },
  },
};

type Translations = typeof translations.en;

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("oto-language") as Language;
      if (stored && translations[stored]) {
        return stored;
      }
    }
    return "en";
  });

  useEffect(() => {
    localStorage.setItem("oto-language", language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
  };

  const t = translations[language];

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}

export function LanguageSelector() {
  const { language, setLanguage, t } = useI18n();
  
  return (
    <select
      value={language}
      onChange={(e) => setLanguage(e.target.value as Language)}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      data-testid="select-language"
    >
      <option value="en">{t.languages.en}</option>
      <option value="ru">{t.languages.ru}</option>
      <option value="th">{t.languages.th}</option>
    </select>
  );
}
