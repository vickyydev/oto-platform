import { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { requireAuth } from "./auth";
import { requireRole } from "./auth-middleware";
import type { DropoffFormSchemaJson, DropoffFormSection, DropoffFormField } from "./db/coreSchema";
import { translateTexts } from "./translation-service";

// Default form schema based on current hard-coded form
const DEFAULT_FORM_SCHEMA: DropoffFormSchemaJson = {
  titleKey: "dropoff.title",
  descriptionKey: "dropoff.description",
  sections: [
    {
      id: "guardian_info",
      titleKey: "dropoff.section.guardian.title",
      descriptionKey: "dropoff.section.guardian.description",
      displayOrder: 0,
      fields: [
        {
          id: "parent_full_name",
          type: "text",
          required: true,
          labelKey: "dropoff.parent_full_name.label",
          placeholderKey: "dropoff.parent_full_name.placeholder",
          validation: { minLength: 2, maxLength: 120 },
          displayOrder: 0,
        },
        {
          id: "contact_method",
          type: "radio",
          required: true,
          labelKey: "dropoff.contact_method.label",
          helpTextKey: "dropoff.contact_method.help",
          options: [
            { value: "whatsapp", labelKey: "dropoff.contact_method.whatsapp" },
            { value: "telegram", labelKey: "dropoff.contact_method.telegram" },
          ],
          displayOrder: 1,
        },
        {
          id: "whatsapp_phone",
          type: "phone",
          required: true,
          labelKey: "dropoff.whatsapp_phone.label",
          placeholderKey: "dropoff.whatsapp_phone.placeholder",
          helpTextKey: "dropoff.whatsapp_phone.help",
          displayOrder: 2,
          visibilityRule: {
            fieldId: "contact_method",
            operator: "equals",
            value: "whatsapp",
          },
        },
        {
          id: "telegram_phone",
          type: "phone",
          required: true,
          labelKey: "dropoff.telegram_phone.label",
          placeholderKey: "dropoff.telegram_phone.placeholder",
          helpTextKey: "dropoff.telegram_phone.help",
          validation: { minLength: 5, maxLength: 20 },
          displayOrder: 3,
          visibilityRule: {
            fieldId: "contact_method",
            operator: "equals",
            value: "telegram",
          },
        },
      ],
    },
    {
      id: "children_info",
      titleKey: "dropoff.section.children.title",
      descriptionKey: "dropoff.section.children.description",
      displayOrder: 1,
      repeatable: true,
      maxRepeats: 6,
      fields: [
        {
          id: "child_name",
          type: "text",
          required: true,
          labelKey: "dropoff.child_name.label",
          placeholderKey: "dropoff.child_name.placeholder",
          displayOrder: 0,
        },
        {
          id: "child_age",
          type: "select",
          required: true,
          labelKey: "dropoff.child_age.label",
          options: [
            { value: "1", labelKey: "dropoff.child_age.option.1" },
            { value: "2", labelKey: "dropoff.child_age.option.2" },
            { value: "3", labelKey: "dropoff.child_age.option.3" },
            { value: "4", labelKey: "dropoff.child_age.option.4" },
            { value: "5", labelKey: "dropoff.child_age.option.5" },
            { value: "6", labelKey: "dropoff.child_age.option.6" },
            { value: "7", labelKey: "dropoff.child_age.option.7" },
            { value: "8", labelKey: "dropoff.child_age.option.8" },
            { value: "9", labelKey: "dropoff.child_age.option.9" },
            { value: "10", labelKey: "dropoff.child_age.option.10" },
            { value: "11", labelKey: "dropoff.child_age.option.11" },
            { value: "12", labelKey: "dropoff.child_age.option.12" },
          ],
          displayOrder: 1,
        },
      ],
    },
    {
      id: "health_info",
      titleKey: "dropoff.section.health.title",
      displayOrder: 2,
      fields: [
        {
          id: "has_allergies_or_medical",
          type: "radio",
          required: true,
          labelKey: "dropoff.has_allergies_or_medical.label",
          options: [
            { value: "yes", labelKey: "dropoff.yes" },
            { value: "no", labelKey: "dropoff.no" },
          ],
          displayOrder: 0,
        },
        {
          id: "allergies_medical_details",
          type: "textarea",
          required: false,
          labelKey: "dropoff.allergies_medical_details.label",
          placeholderKey: "dropoff.allergies_medical_details.placeholder",
          displayOrder: 1,
        },
      ],
    },
    {
      id: "food_info",
      titleKey: "dropoff.section.food.title",
      displayOrder: 3,
      fields: [
        {
          id: "allow_staff_order_food",
          type: "radio",
          required: true,
          labelKey: "dropoff.allow_staff_order_food.label",
          options: [
            { value: "yes", labelKey: "dropoff.yes" },
            { value: "no", labelKey: "dropoff.no" },
          ],
          displayOrder: 0,
        },
        {
          id: "food_notes_restrictions",
          type: "textarea",
          required: false,
          labelKey: "dropoff.food_notes_restrictions.label",
          placeholderKey: "dropoff.food_notes_restrictions.placeholder",
          displayOrder: 1,
        },
      ],
    },
    {
      id: "confirmations",
      titleKey: "dropoff.section.confirmations.title",
      displayOrder: 4,
      fields: [
        {
          id: "confirm_mall_15min",
          type: "checkbox",
          required: true,
          labelKey: "dropoff.confirm_mall_15min.label",
          displayOrder: 0,
        },
        {
          id: "confirm_early_pickup_refund",
          type: "checkbox",
          required: true,
          labelKey: "dropoff.confirm_early_pickup_refund.label",
          displayOrder: 1,
        },
        {
          id: "confirm_evac_loading_bay",
          type: "checkbox",
          required: true,
          labelKey: "dropoff.confirm_evac_loading_bay.label",
          displayOrder: 2,
        },
      ],
    },
    {
      id: "verification",
      titleKey: "dropoff.section.verification.title",
      displayOrder: 5,
      fields: [
        {
          id: "photo",
          type: "photo",
          required: true,
          labelKey: "dropoff.photo.label",
          displayOrder: 0,
        },
        {
          id: "signature",
          type: "signature",
          required: true,
          labelKey: "dropoff.signature.label",
          displayOrder: 1,
        },
      ],
    },
  ],
  submitTextKey: "dropoff.submit",
  successMessageKey: "dropoff.success",
  requiresPhoto: true,
  requiresSignature: true,
};

// Default English translations
const DEFAULT_EN_TRANSLATIONS: Record<string, string> = {
  "dropoff.title": "Drop-off Check-in",
  "dropoff.description": "Please fill out this form to check in your child",
  "dropoff.section.guardian.title": "Guardian Information",
  "dropoff.section.guardian.description": "Please provide your contact details",
  "dropoff.parent_full_name.label": "Parent/Guardian Full Name",
  "dropoff.parent_full_name.placeholder": "Enter your full name",
  "dropoff.contact_method.label": "Preferred Contact Method",
  "dropoff.contact_method.help": "How would you like us to contact you for pickup?",
  "dropoff.contact_method.whatsapp": "WhatsApp",
  "dropoff.contact_method.telegram": "Telegram",
  "dropoff.whatsapp_phone.label": "WhatsApp Phone Number",
  "dropoff.whatsapp_phone.placeholder": "Enter your WhatsApp number",
  "dropoff.whatsapp_phone.help": "We will send pickup notifications to this number",
  "dropoff.telegram_phone.label": "Telegram Phone Number",
  "dropoff.telegram_phone.placeholder": "Enter your phone number",
  "dropoff.telegram_phone.help": "We will contact you via Telegram on this phone number",
  "dropoff.section.children.title": "Children Information",
  "dropoff.section.children.description": "Add details for each child",
  "dropoff.number_of_children.label": "Number of Children",
  "dropoff.child_name.label": "Child Name",
  "dropoff.child_name.placeholder": "Enter child's name",
  "dropoff.child_age.label": "Age",
  "dropoff.child_age.option.1": "1 year",
  "dropoff.child_age.option.2": "2 years",
  "dropoff.child_age.option.3": "3 years",
  "dropoff.child_age.option.4": "4 years",
  "dropoff.child_age.option.5": "5 years",
  "dropoff.child_age.option.6": "6 years",
  "dropoff.child_age.option.7": "7 years",
  "dropoff.child_age.option.8": "8 years",
  "dropoff.child_age.option.9": "9 years",
  "dropoff.child_age.option.10": "10 years",
  "dropoff.child_age.option.11": "11 years",
  "dropoff.child_age.option.12": "12 years",
  "dropoff.section.health.title": "Health Information",
  "dropoff.has_allergies_or_medical.label": "Does your child have any allergies or medical conditions?",
  "dropoff.allergies_medical_details.label": "Please provide details",
  "dropoff.allergies_medical_details.placeholder": "Describe allergies or medical conditions...",
  "dropoff.section.food.title": "Food Preferences",
  "dropoff.allow_staff_order_food.label": "Allow staff to order food for your child?",
  "dropoff.food_notes_restrictions.label": "Food restrictions or notes",
  "dropoff.food_notes_restrictions.placeholder": "Any dietary restrictions or preferences...",
  "dropoff.section.confirmations.title": "Confirmations",
  "dropoff.confirm_mall_15min.label": "I confirm that I will remain within the mall and can return within 15 minutes if needed",
  "dropoff.confirm_early_pickup_refund.label": "I understand that early pickup may not be eligible for a refund",
  "dropoff.confirm_evac_loading_bay.label": "I understand that in case of emergency evacuation, I should go to the loading bay area",
  "dropoff.section.verification.title": "Verification",
  "dropoff.photo.label": "Photo of Guardian",
  "dropoff.signature.label": "Your Signature",
  "dropoff.submit": "Submit Check-in",
  "dropoff.success": "Thank you! Your check-in has been submitted successfully.",
  "dropoff.yes": "Yes",
  "dropoff.no": "No",
};

// Helper to resolve tenantId
async function resolveTenantId(tenantId?: string): Promise<string> {
  if (tenantId) return tenantId;
  const defaultTenantId = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
  return defaultTenantId;
}

// Extract all translation keys from a form schema
function extractTranslationKeys(schema: DropoffFormSchemaJson): string[] {
  const keys: string[] = [];
  
  keys.push(schema.titleKey);
  if (schema.descriptionKey) keys.push(schema.descriptionKey);
  keys.push(schema.submitTextKey);
  keys.push(schema.successMessageKey);
  
  for (const section of schema.sections) {
    keys.push(section.titleKey);
    if (section.descriptionKey) keys.push(section.descriptionKey);
    
    for (const field of section.fields) {
      keys.push(field.labelKey);
      if (field.placeholderKey) keys.push(field.placeholderKey);
      if (field.helpTextKey) keys.push(field.helpTextKey);
      
      if (field.options) {
        for (const option of field.options) {
          keys.push(option.labelKey);
        }
      }
    }
  }
  
  return Array.from(new Set(keys)); // Remove duplicates
}

export function registerDropoffFormRoutes(app: Express) {
  // Get or create the dropoff form for the tenant
  app.get("/api/dropoff-form", requireAuth, requireRole("global_admin", "operator_admin", "admin", "manager"), async (req, res, next) => {
    try {
      const tenantId = await resolveTenantId((req.user as any)?.tenantId);
      
      let form = await storage.getDropoffForm(tenantId);
      
      // If no form exists, create one with default schema
      if (!form) {
        form = await storage.createDropoffForm({
          tenantId,
          name: "Drop-off Form",
          status: "draft",
        });
        
        // Create initial version with default schema
        const version = await storage.createDropoffFormVersion({
          formId: form.id,
          versionNumber: 1,
          sourceLanguage: "en",
          schemaJson: DEFAULT_FORM_SCHEMA,
          isDraft: true,
        });
        
        // Create default English translations
        const translations = Object.entries(DEFAULT_EN_TRANSLATIONS).map(([key, value]) => ({
          namespace: "dropoff",
          versionId: version.id,
          lang: "en" as const,
          key,
          value,
          isManualOverride: false,
        }));
        
        await storage.bulkUpsertI18nTranslations(translations);
      }
      
      // Get the latest draft version
      const draftVersion = await storage.getLatestDraftVersion(form.id);
      
      // Get published version if exists
      const publishedVersion = form.activePublishedVersionId 
        ? await storage.getDropoffFormVersion(form.activePublishedVersionId)
        : undefined;
      
      res.json({
        form,
        draftVersion,
        publishedVersion,
      });
    } catch (error) {
      next(error);
    }
  });

  // Get form versions
  app.get("/api/dropoff-form/:formId/versions", requireAuth, requireRole("global_admin", "operator_admin", "admin", "manager"), async (req, res, next) => {
    try {
      const { formId } = req.params;
      const versions = await storage.getDropoffFormVersions(formId);
      res.json(versions);
    } catch (error) {
      next(error);
    }
  });

  // Get form version with translations
  app.get("/api/dropoff-form/version/:versionId", requireAuth, requireRole("global_admin", "operator_admin", "admin", "manager"), async (req, res, next) => {
    try {
      const { versionId } = req.params;
      const { lang } = req.query;
      
      const version = await storage.getDropoffFormVersion(versionId);
      if (!version) {
        return res.status(404).json({ message: "Version not found" });
      }
      
      const translations = await storage.getI18nTranslations(versionId, lang as string | undefined);
      
      res.json({
        version,
        translations,
      });
    } catch (error) {
      next(error);
    }
  });

  // Save draft version
  app.put("/api/dropoff-form/:formId/draft", requireAuth, requireRole("global_admin", "operator_admin", "admin", "manager"), async (req, res, next) => {
    try {
      const { formId } = req.params;
      const { schemaJson, translations } = req.body;
      
      // Get or create draft version
      let draftVersion = await storage.getLatestDraftVersion(formId);
      
      if (!draftVersion) {
        // Get the current max version number
        const versions = await storage.getDropoffFormVersions(formId);
        const maxVersion = versions.length > 0 ? Math.max(...versions.map(v => v.versionNumber)) : 0;
        
        draftVersion = await storage.createDropoffFormVersion({
          formId,
          versionNumber: maxVersion + 1,
          sourceLanguage: "en",
          schemaJson,
          isDraft: true,
        });
      } else {
        // Update existing draft
        draftVersion = await storage.updateDropoffFormVersion(draftVersion.id, {
          schemaJson,
        });
      }
      
      // Update English translations if provided
      if (translations && typeof translations === 'object') {
        const translationEntries = Object.entries(translations).map(([key, value]) => ({
          namespace: "dropoff",
          versionId: draftVersion!.id,
          lang: "en" as const,
          key,
          value: value as string,
          isManualOverride: false,
        }));
        
        await storage.bulkUpsertI18nTranslations(translationEntries);
      }
      
      res.json({ version: draftVersion });
    } catch (error) {
      next(error);
    }
  });

  // Update a single translation
  app.put("/api/dropoff-form/translation", requireAuth, requireRole("global_admin", "operator_admin", "admin", "manager"), async (req, res, next) => {
    try {
      const { versionId, lang, key, value, isManualOverride } = req.body;
      
      const translation = await storage.upsertI18nTranslation({
        namespace: "dropoff",
        versionId,
        lang,
        key,
        value,
        isManualOverride: isManualOverride ?? (lang !== "en"),
      });
      
      res.json(translation);
    } catch (error) {
      next(error);
    }
  });

  // Publish form
  app.post("/api/dropoff-form/:formId/publish", requireAuth, requireRole("global_admin", "operator_admin", "admin"), async (req, res, next) => {
    try {
      const { formId } = req.params;
      const userId = req.user?.id;
      
      // Get draft version
      const draftVersion = await storage.getLatestDraftVersion(formId);
      if (!draftVersion) {
        return res.status(400).json({ message: "No draft version to publish" });
      }
      
      // Validate schema
      const schema = draftVersion.schemaJson as DropoffFormSchemaJson;
      const allKeys = extractTranslationKeys(schema);
      
      // Check that all English translations exist
      const enTranslations = await storage.getI18nTranslations(draftVersion.id, "en");
      const enKeys = new Set(enTranslations.map(t => t.key));
      const missingEnKeys = allKeys.filter(k => !enKeys.has(k));
      
      if (missingEnKeys.length > 0) {
        return res.status(400).json({ 
          message: "Missing English translations", 
          missingKeys: missingEnKeys 
        });
      }
      
      // Mark version as published
      const publishedVersion = await storage.updateDropoffFormVersion(draftVersion.id, {
        isDraft: false,
        publishedAt: new Date(),
        publishedByUserId: userId,
      });
      
      // Update form to point to this version
      await storage.updateDropoffForm(formId, {
        status: "published",
        activePublishedVersionId: publishedVersion.id,
      });
      
      // Create translation job for other languages
      const job = await storage.createTranslationJob({
        versionId: publishedVersion.id,
        status: "queued",
        targetLanguages: ["th", "ru", "zh"],
      });
      
      // Get existing translations to check for manual overrides
      const existingTranslations = await storage.getI18nTranslations(publishedVersion.id);
      
      // Auto-translate using OpenAI for TH/RU/ZH
      for (const lang of ["th", "ru", "zh"] as const) {
        console.log(`[Publish] Generating ${lang.toUpperCase()} translations...`);
        
        // Filter out keys that have manual overrides
        const textsToTranslate = enTranslations.filter(enT => {
          const existing = existingTranslations.find(t => t.lang === lang && t.key === enT.key);
          return !existing?.isManualOverride;
        }).map(t => ({ key: t.key, value: t.value }));
        
        if (textsToTranslate.length === 0) {
          console.log(`[Publish] No translations needed for ${lang} (all manual overrides)`);
          continue;
        }
        
        try {
          const results = await translateTexts(textsToTranslate, lang);
          
          let successCount = 0;
          for (const result of results) {
            await storage.upsertI18nTranslation({
              namespace: "dropoff",
              versionId: publishedVersion.id,
              lang,
              key: result.key,
              value: result.translatedValue,
              isManualOverride: false,
            });
            if (result.success) successCount++;
          }
          
          console.log(`[Publish] ${lang.toUpperCase()}: ${successCount}/${results.length} translations successful`);
        } catch (error) {
          console.error(`[Publish] Translation failed for ${lang}:`, error);
          // Fall back to English values on error
          for (const enT of textsToTranslate) {
            await storage.upsertI18nTranslation({
              namespace: "dropoff",
              versionId: publishedVersion.id,
              lang,
              key: enT.key,
              value: enT.value,
              isManualOverride: false,
            });
          }
        }
      }
      
      // Mark job as done
      await storage.updateTranslationJob(job.id, {
        status: "done",
        finishedAt: new Date(),
      });
      
      res.json({
        message: "Form published successfully",
        version: publishedVersion,
      });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // PUBLIC ENDPOINTS (for guest form)
  // ============================================

  // Get published form for guests (no auth required)
  app.get("/api/public/dropoff-form/:branchId", async (req, res, next) => {
    try {
      const { branchId } = req.params;
      const { lang = "en" } = req.query;
      
      // Get the tenant from branch
      const branch = await storage.getBranch(branchId);
      if (!branch) {
        return res.status(404).json({ message: "Branch not found" });
      }
      
      // Get the form for this tenant (global form, not branch-specific for now)
      const form = await storage.getDropoffForm(branch.tenantId);
      if (!form || !form.activePublishedVersionId) {
        return res.status(404).json({ message: "Form temporarily unavailable" });
      }
      
      // Get the published version
      const version = await storage.getDropoffFormVersion(form.activePublishedVersionId);
      if (!version) {
        return res.status(404).json({ message: "Form temporarily unavailable" });
      }
      
      // Get translations for requested language + English fallback
      const requestedLang = lang as string;
      const translations = await storage.getI18nTranslations(version.id, requestedLang);
      const enTranslations = requestedLang !== "en" 
        ? await storage.getI18nTranslations(version.id, "en")
        : translations;
      
      // Build translation map with fallback
      const translationMap: Record<string, string> = {};
      for (const t of enTranslations) {
        translationMap[t.key] = t.value;
      }
      for (const t of translations) {
        translationMap[t.key] = t.value;
      }
      
      res.json({
        versionId: version.id,
        schema: version.schemaJson,
        translations: translationMap,
        language: requestedLang,
        availableLanguages: ["en", "th", "ru", "zh"],
      });
    } catch (error) {
      next(error);
    }
  });
}
