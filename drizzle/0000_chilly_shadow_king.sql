CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`opening_balance_native` integer DEFAULT 0 NOT NULL,
	`icon` text,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "accounts_type_valid" CHECK("accounts"."type" IN ('cash','bank','credit','splitwise','loan')),
	CONSTRAINT "accounts_currency_format" CHECK("accounts"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "accounts_opening_integer" CHECK(typeof("accounts"."opening_balance_native") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_ci` ON `accounts` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`icon` text,
	`color` text,
	`people_backed` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "categories_kind_valid" CHECK("categories"."kind" IN ('income','expense'))
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_name_ci` ON `people` ("name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`type` text NOT NULL,
	`account_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount_native` integer NOT NULL,
	`amount_usd` integer NOT NULL,
	`fx_rate` real DEFAULT 1 NOT NULL,
	`category_id` text,
	`person_id` text,
	`merchant` text,
	`note` text,
	`transfer_group_id` text,
	`import_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tx_type_valid" CHECK("transactions"."type" IN ('income','expense','transfer')),
	CONSTRAINT "tx_expense_shape" CHECK("transactions"."type" <> 'expense' OR ("transactions"."amount_native" < 0 AND "transactions"."category_id" IS NOT NULL)),
	CONSTRAINT "tx_income_shape" CHECK("transactions"."type" <> 'income' OR ("transactions"."amount_native" > 0 AND "transactions"."category_id" IS NOT NULL)),
	CONSTRAINT "tx_transfer_shape" CHECK("transactions"."type" <> 'transfer' OR ("transactions"."category_id" IS NULL AND "transactions"."transfer_group_id" IS NOT NULL)),
	CONSTRAINT "tx_usd_rate" CHECK("transactions"."currency" <> 'USD' OR ("transactions"."amount_native" = "transactions"."amount_usd" AND "transactions"."fx_rate" = 1.0)),
	CONSTRAINT "tx_foreign_rate" CHECK("transactions"."currency" = 'USD' OR ("transactions"."fx_rate" > 0 AND ABS(ABS("transactions"."amount_native") / "transactions"."fx_rate" - ABS("transactions"."amount_usd")) <= 1)),
	CONSTRAINT "tx_sign_match" CHECK(("transactions"."amount_native" > 0 AND "transactions"."amount_usd" > 0) OR ("transactions"."amount_native" < 0 AND "transactions"."amount_usd" < 0) OR ("transactions"."amount_native" = 0 AND "transactions"."amount_usd" = 0)),
	CONSTRAINT "tx_money_integer" CHECK(typeof("transactions"."amount_native") = 'integer' AND typeof("transactions"."amount_usd") = 'integer'),
	CONSTRAINT "tx_fx_numeric" CHECK(typeof("transactions"."fx_rate") IN ('real','integer')),
	CONSTRAINT "tx_currency_format" CHECK("transactions"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "tx_group_only_on_transfer" CHECK("transactions"."transfer_group_id" IS NULL OR "transactions"."type" = 'transfer'),
	CONSTRAINT "tx_transfer_nonzero" CHECK("transactions"."type" <> 'transfer' OR "transactions"."amount_native" <> 0),
	CONSTRAINT "tx_occurred_format" CHECK("transactions"."occurred_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_import_hash` ON `transactions` (`import_hash`) WHERE "transactions"."import_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_occurred` ON `transactions` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_account` ON `transactions` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_group` ON `transactions` (`transfer_group_id`);