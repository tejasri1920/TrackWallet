-- Constraints Drizzle cannot express. See docs/DECISIONS.md (A) and docs/INVARIANTS.md.
-- Uniqueness of a category name within (kind, parent), case-insensitive, with NULL parent
-- treated as ''. Top-level rows would otherwise never collide (NULL != NULL in a unique index).
CREATE UNIQUE INDEX `categories_unique` ON `categories` (`kind`, IFNULL(`parent_id`, ''), `name` COLLATE NOCASE);--> statement-breakpoint

-- Invariant 9: category depth <= 2 (a subcategory cannot have children).
CREATE TRIGGER `trg_cat_depth_ins` BEFORE INSERT ON `categories`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'category depth must be <= 2: parent is itself a subcategory')
  WHERE (SELECT `parent_id` FROM `categories` WHERE `id` = NEW.`parent_id`) IS NOT NULL
     OR NEW.`parent_id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_cat_depth_upd` BEFORE UPDATE OF `parent_id` ON `categories`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'category depth must be <= 2: parent is itself a subcategory')
  WHERE (SELECT `parent_id` FROM `categories` WHERE `id` = NEW.`parent_id`) IS NOT NULL
     OR NEW.`parent_id` = NEW.`id`;
  SELECT RAISE(ABORT, 'category depth must be <= 2: category already has children')
  WHERE EXISTS (SELECT 1 FROM `categories` WHERE `parent_id` = NEW.`id`);
END;--> statement-breakpoint

-- Invariants 1/2 (category kind side): a category cannot change kind or lose people_backed
-- while transactions rely on it.
CREATE TRIGGER `trg_cat_kind_upd` BEFORE UPDATE OF `kind` ON `categories`
BEGIN
  SELECT RAISE(ABORT, 'category kind cannot change while transactions of the other type use it')
  WHERE EXISTS (
    SELECT 1 FROM `transactions`
    WHERE `category_id` = NEW.`id` AND `type` IN ('income','expense') AND `type` <> NEW.`kind`
  );
END;--> statement-breakpoint
CREATE TRIGGER `trg_cat_people_backed_upd` BEFORE UPDATE OF `people_backed` ON `categories`
WHEN NEW.`people_backed` <> 1
BEGIN
  SELECT RAISE(ABORT, 'people_backed cannot be cleared while transactions reference a person under it')
  WHERE EXISTS (
    SELECT 1 FROM `transactions` WHERE `category_id` = NEW.`id` AND `person_id` IS NOT NULL
  );
END;--> statement-breakpoint

-- Invariants 1/2 (category kind side): expense rows need an expense category, income rows an
-- income category. A missing category is left to the foreign key so its error stays precise.
CREATE TRIGGER `trg_tx_category_kind_ins` BEFORE INSERT ON `transactions`
WHEN NEW.`category_id` IS NOT NULL AND NEW.`type` IN ('income','expense')
BEGIN
  SELECT RAISE(ABORT, 'category kind does not match transaction type')
  WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`category_id`)
    AND (SELECT `kind` FROM `categories` WHERE `id` = NEW.`category_id`) IS NOT NEW.`type`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_tx_category_kind_upd` BEFORE UPDATE ON `transactions`
WHEN NEW.`category_id` IS NOT NULL AND NEW.`type` IN ('income','expense')
BEGIN
  SELECT RAISE(ABORT, 'category kind does not match transaction type')
  WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`category_id`)
    AND (SELECT `kind` FROM `categories` WHERE `id` = NEW.`category_id`) IS NOT NEW.`type`;
END;--> statement-breakpoint

-- Invariant 10: person_id requires a people_backed category.
CREATE TRIGGER `trg_tx_person_ins` BEFORE INSERT ON `transactions`
WHEN NEW.`person_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'person_id requires a people_backed category')
  WHERE (SELECT `people_backed` FROM `categories` WHERE `id` = NEW.`category_id`) IS NOT 1;
END;--> statement-breakpoint
CREATE TRIGGER `trg_tx_person_upd` BEFORE UPDATE ON `transactions`
WHEN NEW.`person_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'person_id requires a people_backed category')
  WHERE (SELECT `people_backed` FROM `categories` WHERE `id` = NEW.`category_id`) IS NOT 1;
END;--> statement-breakpoint

-- Invariants 4/5 (insert side): a transfer group never gets a third live leg, and its second
-- live leg must offset the first exactly in amount_usd (plus the two rules below). Deliberately INSERT-only: editing a
-- transfer updates both legs, and the intermediate state would be unbalanced. Edits and
-- soft-deletes go through the domain write functions; the invariant queries are the audit.
CREATE TRIGGER `trg_tx_transfer_group_ins` BEFORE INSERT ON `transactions`
WHEN NEW.`transfer_group_id` IS NOT NULL AND NEW.`deleted_at` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'transfer group already has 2 live legs')
  WHERE (SELECT COUNT(*) FROM `transactions`
         WHERE `transfer_group_id` = NEW.`transfer_group_id` AND `deleted_at` IS NULL) >= 2;
  SELECT RAISE(ABORT, 'transfer legs must sum to zero in amount_usd')
  WHERE (SELECT COUNT(*) FROM `transactions`
         WHERE `transfer_group_id` = NEW.`transfer_group_id` AND `deleted_at` IS NULL) = 1
    AND (SELECT SUM(`amount_usd`) FROM `transactions`
         WHERE `transfer_group_id` = NEW.`transfer_group_id` AND `deleted_at` IS NULL)
        + NEW.`amount_usd` <> 0;
  -- By here the group has at most one live leg. The two legs must be on different accounts, and
  -- if they share a currency they must offset in that currency too (else a same-currency
  -- transfer could create or destroy native money while still netting to zero USD).
  SELECT RAISE(ABORT, 'transfer legs must be on different accounts')
  WHERE EXISTS (SELECT 1 FROM `transactions`
                WHERE `transfer_group_id` = NEW.`transfer_group_id` AND `deleted_at` IS NULL
                  AND `account_id` = NEW.`account_id`);
  SELECT RAISE(ABORT, 'same-currency transfer legs must offset in amount_native')
  WHERE EXISTS (SELECT 1 FROM `transactions`
                WHERE `transfer_group_id` = NEW.`transfer_group_id` AND `deleted_at` IS NULL
                  AND `currency` = NEW.`currency`
                  AND `amount_native` + NEW.`amount_native` <> 0);
END;
--> statement-breakpoint

-- Subcategory kind must equal its parent's kind (agreed after the Phase 1 review, finding 8).
-- A missing parent is left to the foreign key so its error stays precise.
CREATE TRIGGER `trg_cat_kind_parent_ins` BEFORE INSERT ON `categories`
WHEN NEW.`parent_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'subcategory kind must equal its parent kind')
  WHERE EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`parent_id`)
    AND (SELECT `kind` FROM `categories` WHERE `id` = NEW.`parent_id`) IS NOT NEW.`kind`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_cat_kind_parent_upd` BEFORE UPDATE OF `kind`, `parent_id` ON `categories`
BEGIN
  SELECT RAISE(ABORT, 'subcategory kind must equal its parent kind')
  WHERE NEW.`parent_id` IS NOT NULL
    AND EXISTS (SELECT 1 FROM `categories` WHERE `id` = NEW.`parent_id`)
    AND (SELECT `kind` FROM `categories` WHERE `id` = NEW.`parent_id`) IS NOT NEW.`kind`;
  SELECT RAISE(ABORT, 'category kind cannot change while it has subcategories of the other kind')
  WHERE EXISTS (SELECT 1 FROM `categories` WHERE `parent_id` = NEW.`id` AND `kind` <> NEW.`kind`);
END;
