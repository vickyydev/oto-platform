ALTER TABLE "pos"."product" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "product_variants_idx" ON "pos"."product" USING gin ("variants" jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "pos"."product" ADD CONSTRAINT "product_variants_array_check" CHECK (jsonb_typeof("pos"."product"."variants") = 'array');