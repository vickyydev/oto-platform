/**
 * The two park menus, as printed, merged into one list.
 *
 * Sources, transcribed 2026-11-09: `Menu_eng_CENTRAL.pdf` (Oto Play Park, Central
 * Floresta, lines 1-71) and `Menu_eng_ROBINSON_chalong.pdf` (Oto Play Park, Robinson
 * Chalong, lines 1-68). Both print "All prices are inclusive of VAT and service charge."
 * Generated once from that transcription; edit it by hand from here on (README.md).
 *
 * One entry per printed line. `numbers` is the line's printed number on each park's
 * menu; a park missing from it does not print the line. A section price printed once
 * (Soda, Smoothies, Juice, Tea pot, Kids juice) is already on each of its lines.
 * Names, descriptions, option names and diet icons are copied as printed, typos and
 * case included; nothing here is a translation or a guess.
 */
import type { MenuLine } from './types';

export const MENU_LINES: readonly MenuLine[] = [
  // --- Breakfast -------------------------------------------------------------
  { category: 'CAT-BREAKFAST', name: 'Big breakfast', numbers: { central: '1', chalong: '1' }, baht: 460, description: 'Hashbrown, tomato, mushroom, baked beans, sausage, bacon, egg, sourdough' },
  { category: 'CAT-BREAKFAST', name: 'Vegetarian breakfast', numbers: { central: '2', chalong: '2' }, baht: 400, description: 'Hashbrown, tomato, mushroom, baked beans, avocado, egg, sourdough', diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Smashed avocado + bruschetta', numbers: { central: '3', chalong: '3' }, baht: 370, description: 'Pico de gallo, avocado, cherry tomato', diet: ['vegetarian', 'dairy-free'], addOns: [{ name: 'Egg your way', baht: 50, printed: 'Add on egg your way — 50 THB' }] },
  { category: 'CAT-BREAKFAST', name: 'Waffles', numbers: { central: '4', chalong: '4' }, baht: 255, descriptionByPark: { central: 'Banana, blueberry , choice of sauce', chalong: 'Banana, blueberry, choice of sauce' }, diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Pancakes', numbers: { central: '5', chalong: '5' }, baht: 255, descriptionByPark: { central: 'Banana, blueberry , choice of sauce', chalong: 'Banana, blueberry, choice of sauce' }, diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Porridge', numbers: { central: '6', chalong: '6' }, baht: 230, description: 'Oat, mango, honey', diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Yogurt', numbers: { central: '7', chalong: '7' }, baht: 230, description: 'Granola, mixed berry compote, honey', diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Syrniki', numbers: { central: '8', chalong: '8' }, baht: 230, description: 'Sour cream, mixed berry compote', diet: ['vegetarian'] },
  { category: 'CAT-BREAKFAST', name: 'Smoked salmon toast', numbers: { central: '9' }, baht: 390, description: 'Smoked salmon, red radish, cream cheese, red onion, capers, dill' },
  // --- Sides -----------------------------------------------------------------
  { category: 'CAT-SIDES', name: 'Sautéed mushrooms', numbers: { central: '10.1', chalong: '9.1' }, baht: 60 },
  { category: 'CAT-SIDES', name: 'Grilled tomato', numbers: { central: '10.2', chalong: '9.2' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Baked beans', numbers: { central: '10.3', chalong: '9.3' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Hashbrown', numbers: { central: '10.4', chalong: '9.4' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Bread', numbers: { central: '10.5', chalong: '9.5' }, baht: 70 },
  { category: 'CAT-SIDES', name: 'Avocado', numbers: { central: '10.6', chalong: '9.6' }, baht: 110 },
  { category: 'CAT-SIDES', name: 'Plain pasta', numbers: { central: '10.7', chalong: '9.7' }, baht: 115 },
  { category: 'CAT-SIDES', name: 'Bacon', numbers: { central: '10.8', chalong: '9.8' }, baht: 70 },
  { category: 'CAT-SIDES', name: 'Sausages', numbers: { central: '10.9', chalong: '9.9' }, baht: 95 },
  { category: 'CAT-SIDES', name: 'Grilled shrimp', numbers: { central: '10.10', chalong: '9.10' }, baht: 95 },
  { category: 'CAT-SIDES', name: 'Grilled chicken', numbers: { central: '10.11', chalong: '9.11' }, baht: 70 },
  { category: 'CAT-SIDES', name: 'Smoked salmon', numbers: { central: '10.12', chalong: '9.12' }, baht: 115 },
  { category: 'CAT-SIDES', name: 'Pico de gallo', numbers: { central: '10.13', chalong: '9.13' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Parma ham', numbers: { central: '10.14', chalong: '9.14' }, baht: 175 },
  { category: 'CAT-SIDES', name: 'Yogurt', numbers: { central: '10.15', chalong: '9.15' }, baht: 135 },
  { category: 'CAT-SIDES', name: 'Sour cream', numbers: { central: '10.16', chalong: '9.16' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Steamed jasmine rice', numbers: { central: '10.17', chalong: '9.17' }, baht: 50 },
  { category: 'CAT-SIDES', name: 'Eggs your way', numbers: { central: '10.18', chalong: '9.18' }, baht: 50 },
  // --- Sharing ---------------------------------------------------------------
  { category: 'CAT-SHARING', name: 'French fries', numbers: { central: '11', chalong: '10' }, baht: 175, description: 'Ketchup or mayonnaise', diet: ['vegetarian'] },
  { category: 'CAT-SHARING', name: 'Sweet potato fries', numbers: { central: '12', chalong: '11' }, baht: 175, description: 'Ketchup or mayonnaise', diet: ['vegetarian'] },
  { category: 'CAT-SHARING', name: 'Hummus', numbers: { central: '13', chalong: '12' }, baht: 275, description: 'Carrot, cucumber, cherry tomato, capsicum, crackers', diet: ['vegetarian', 'dairy-free'] },
  { category: 'CAT-SHARING', name: 'Calamari', numbers: { central: '14', chalong: '13' }, baht: 295, description: 'Lemon dill aioli, lemon wedge' },
  // --- Soup ------------------------------------------------------------------
  { category: 'CAT-SOUP', name: 'Special soup of the month', numbers: { central: '19', chalong: '14' }, baht: 240, description: 'Serve with toasted sourdough' },
  // --- Salads ----------------------------------------------------------------
  { category: 'CAT-SALADS', name: 'Caesar salad', numbers: { central: '15', chalong: '15' }, baht: 370, description: 'Cos, garlic herb croutons, parmesan, bacon' },
  // Printed indented under 15; the price is the full printed price of this line.
  { category: 'CAT-SALADS', name: 'With chicken', numbers: { central: '15.1', chalong: '15.1' }, baht: 415, parentName: 'Caesar salad' },
  // Printed indented under 15; the price is the full printed price of this line.
  { category: 'CAT-SALADS', name: 'With shrimp', numbers: { central: '15.2', chalong: '15.2' }, baht: 425, parentName: 'Caesar salad' },
  { category: 'CAT-SALADS', name: 'Barley & quinoa warm salad', numbers: { central: '16', chalong: '16' }, baht: 415, description: 'Barley, quinoa, sauteed vegetables, grilled chicken, boiled egg' },
  { category: 'CAT-SALADS', name: 'Kale & rocket salad', numbers: { central: '17', chalong: '17' }, baht: 370, description: 'Kale, rocket, avocado, red radish, citrus oregano dressing', diet: ['vegetarian', 'dairy-free'] },
  { category: 'CAT-SALADS', name: 'Burrata salad', numbers: { central: '18', chalong: '18' }, baht: 560, description: 'Burrata, tomato, beetroot, rocket, balsamic reduction' },
  // --- Pasta -----------------------------------------------------------------
  { category: 'CAT-PASTA', name: 'Spaghetti Bolognese', numbers: { central: '20', chalong: '19' }, baht: 400, description: 'Australian beef, tomato sauce, parmesan' },
  { category: 'CAT-PASTA', name: 'Fettuccine gorgonzola & mushroom', numbers: { central: '21', chalong: '20' }, baht: 445, description: 'Mushrooms, gorgonzola creamy sauce' },
  { category: 'CAT-PASTA', name: 'Spaghetti AOP', numbers: { central: '22', chalong: '21' }, baht: 380, subtitle: '/aglio e olio peperoncino/', description: 'Garlic, chili, olives, cherry tomato, parmesan', diet: ['vegetarian'] },
  { category: 'CAT-PASTA', name: 'Fettuccine Arrabbiata', numbers: { central: '23', chalong: '22' }, baht: 380, description: 'Garlic, tomato sauce, chili, cherry tomato, italian basil', diet: ['vegetarian', 'dairy-free'] },
  // --- Pizza -----------------------------------------------------------------
  { category: 'CAT-PIZZA', name: 'Margherita', numbers: { central: '24', chalong: '23' }, baht: 400, description: 'Tomato sauce, basil, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Mushroom & olives', numbers: { central: '25', chalong: '24' }, baht: 480, description: 'Mushroom, olives, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Four cheese', numbers: { central: '26', chalong: '25' }, baht: 515, description: 'Gorgonzola, cheddar, parmesan, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Hawaiian', numbers: { central: '27', chalong: '26' }, baht: 515, description: 'Ham, pineapple, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Smoked salmon', numbers: { central: '28', chalong: '27' }, baht: 560, description: 'Smoked salmon, capers, red onion, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Burrata & parma ham', numbers: { central: '29', chalong: '28' }, baht: 590, description: 'Burrata, parma ham, rocket, balsamic reduction, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Sausage, brie & onion', numbers: { central: '30', chalong: '29' }, baht: 480, description: 'Pork sausage, brie, onion, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Pepperoni', numbers: { central: '31', chalong: '30' }, baht: 420, description: 'Tomato sauce, pepperoni, mozzarella' },
  { category: 'CAT-PIZZA', name: 'Veggie delight', numbers: { central: '32', chalong: '31' }, baht: 390, description: 'Capsicum, red onion, cherry tomato, zucchini, mozzarella' },
  // --- Mains -----------------------------------------------------------------
  { category: 'CAT-MAINS', name: 'Sea bass with chimichurri', numbers: { central: '33', chalong: '32' }, baht: 580, description: 'Grilled sea bass, chimichurri, sauteed potatoes' },
  { category: 'CAT-MAINS', name: 'Honey balsamic chicken', numbers: { central: '34', chalong: '33' }, baht: 480, description: 'Grilled chicken breast, honey balsamic glaze, mashed potatoes' },
  { category: 'CAT-MAINS', name: 'Beef burger', numbers: { central: '35', chalong: '34' }, baht: 480, description: 'Angus beef patty, cheddar, house sauce, fries' },
  { category: 'CAT-MAINS', name: 'Fish & chips', numbers: { central: '36', chalong: '35' }, baht: 445, description: 'Battered sea bass, tartar sauce, fries' },
  { category: 'CAT-MAINS', name: 'Chicken schnitzel', numbers: { central: '37', chalong: '36' }, baht: 425, description: 'Crispy breaded chicken, side salad, lemon' },
  { category: 'CAT-MAINS', name: 'Beef stroganoff', numbers: { central: '38' }, baht: 490, description: 'Mashed potato or steamed jasmine rice' },
  { category: 'CAT-MAINS', name: 'Grilled chicken wrap', numbers: { central: '39', chalong: '37' }, baht: 380, description: 'Grilled cajun chicken, tortilla, cos, tomato, cheddar cheese, avocado' },
  { category: 'CAT-MAINS', name: 'Falafel wrap', numbers: { central: '40', chalong: '38' }, baht: 330, description: 'Falafel, tortilla, cos, carrot, tomato, red onion, tahini coriander sauce, mint yogurt' },
  // --- Asian Food ------------------------------------------------------------
  { category: 'CAT-ASIAN-FOOD', name: 'Pad krapao', numbers: { central: '41', chalong: '39' }, baht: 280, description: 'Thai basil stir-fry, garlic, chili, jasmine rice', diet: ['dairy-free', 'gluten-free'], choices: [{ name: 'Protein', printed: '/Vegetarian, chicken, or shrimp/', options: ['Vegetarian', 'chicken', 'shrimp'] }], addOns: [{ name: 'Fried egg', baht: 50, printed: 'Add on fried egg is optional — 50 THB' }] },
  { category: 'CAT-ASIAN-FOOD', name: 'Pad Thai', numbers: { central: '42', chalong: '40' }, baht: 280, description: 'Rice noodles, tamarind sauce, lime, egg', diet: ['dairy-free'], choices: [{ name: 'Protein', printed: '/Vegetarian, chicken, or shrimp/', options: ['Vegetarian', 'chicken', 'shrimp'] }] },
  { category: 'CAT-ASIAN-FOOD', name: 'Fried rice', numbers: { central: '43', chalong: '41' }, baht: 240, description: 'Carrot, onion, spring onion, egg', diet: ['dairy-free', 'gluten-free'], choices: [{ name: 'Protein', printed: '/Vegetarian, chicken, or shrimp/', options: ['Vegetarian', 'chicken', 'shrimp'] }], addOns: [{ name: 'Fried egg', baht: 50, printed: 'Add on fried egg is optional — 50 THB' }] },
  { category: 'CAT-ASIAN-FOOD', name: 'Sichuan dumpling', numbers: { central: '44', chalong: '42' }, baht: 299, description: 'Pork, bok choy, sesame chili oil', diet: ['dairy-free'] },
  { category: 'CAT-ASIAN-FOOD', name: 'Chinese dumpling in chicken broth', numbers: { central: '45', chalong: '43' }, baht: 240, description: 'Wonton, bok choy', diet: ['dairy-free'] },
  { category: 'CAT-ASIAN-FOOD', name: 'Sichuan dan dan noodle', numbers: { central: '46', chalong: '44' }, baht: 299, description: 'Noodle, bok choy, spring onion, sesame paste, roasted peanut', diet: ['dairy-free'], choices: [{ name: 'Choice', printed: '/Pork / Vegetarian/', options: ['Pork', 'Vegetarian'] }] },
  { category: 'CAT-ASIAN-FOOD', name: 'Gyoza', numbers: { central: '47', chalong: '45' }, baht: 299, choices: [{ name: 'Choice', printed: '/Pork / Beef/', options: ['Pork', 'Beef'] }] },
  // --- Kids ------------------------------------------------------------------
  { category: 'CAT-KIDS', name: 'Mac & cheese', numbers: { central: '48', chalong: '46' }, baht: 220, description: 'Creamy cheese sauce, macaroni' },
  { category: 'CAT-KIDS', name: 'Waffle', numbers: { central: '49', chalong: '47' }, baht: 180, description: 'Banana, blueberry, choice of sauce', diet: ['vegetarian'] },
  { category: 'CAT-KIDS', name: 'Pancake', numbers: { central: '50', chalong: '48' }, baht: 180, description: 'Banana, blueberry, choice of sauce', diet: ['vegetarian'] },
  { category: 'CAT-KIDS', name: 'Pelmeni', numbers: { central: '51', chalong: '49' }, baht: 250, description: 'Dumplings, sour cream, dill' },
  { category: 'CAT-KIDS', name: 'Chicken soup', numbers: { central: '52', chalong: '50' }, baht: 210, description: 'Chicken broth, noodles of your choice, vegetables, chicken', diet: ['dairy-free'], choices: [{ name: 'Choice', printed: '/Rice noodle / Pasta/', options: ['Rice noodle', 'Pasta'] }] },
  { category: 'CAT-KIDS', name: 'Vegetable sticks', numbers: { central: '53', chalong: '51' }, baht: 90, description: 'Carrot, cucumber', diet: ['vegetarian', 'dairy-free', 'gluten-free'] },
  { category: 'CAT-KIDS', name: 'Cutlet & mash', numbers: { central: '54', chalong: '52' }, baht: 260, description: 'Tender cutlet, mashed potatoes' },
  { category: 'CAT-KIDS', name: 'Hotdog', numbers: { central: '55' }, baht: 210, description: 'Served with fries, cheese, bacon', choices: [{ name: 'Choice', printed: '/Chicken / Pork/', options: ['Chicken', 'Pork'] }] },
  // --- Desserts --------------------------------------------------------------
  { category: 'CAT-DESSERTS', name: 'Ice cream', numbers: { central: '56', chalong: '53' }, baht: 90, description: 'Your choice of flavor' },
  // No price printed.
  { category: 'CAT-DESSERTS', name: 'Selection of cakes', numbers: { central: '57', chalong: '54' }, baht: null, description: 'Available at the counter' },
  // --- Coffee ----------------------------------------------------------------
  { category: 'CAT-COFFEE', name: 'Espresso', numbers: { central: '58.1', chalong: '55.1' }, baht: 115 },
  { category: 'CAT-COFFEE', name: 'Americano', numbers: { central: '58.2', chalong: '55.2' }, baht: 115 },
  { category: 'CAT-COFFEE', name: 'Cappuccino', numbers: { central: '58.3', chalong: '55.3' }, baht: 140 },
  { category: 'CAT-COFFEE', name: 'Latte', numbers: { central: '58.4', chalong: '55.4' }, baht: 145 },
  { category: 'CAT-COFFEE', name: 'Mocha', numbers: { central: '58.5', chalong: '55.5' }, baht: 155 },
  { category: 'CAT-COFFEE', name: 'Vanilla latte', numbers: { central: '58.6', chalong: '55.6' }, baht: 155 },
  { category: 'CAT-COFFEE', name: 'Caramel macchiato', numbers: { central: '58.7', chalong: '55.7' }, baht: 155 },
  // --- Iced Coffee -----------------------------------------------------------
  { category: 'CAT-ICED-COFFEE', name: 'Iced americano', numbers: { central: '59.1', chalong: '56.1' }, baht: 140 },
  { category: 'CAT-ICED-COFFEE', name: 'Iced latte', numbers: { central: '59.2', chalong: '56.2' }, baht: 155 },
  { category: 'CAT-ICED-COFFEE', name: 'Iced cappuccino', numbers: { central: '59.3', chalong: '56.3' }, baht: 155 },
  { category: 'CAT-ICED-COFFEE', name: 'Iced mocha', numbers: { central: '59.4', chalong: '56.4' }, baht: 170 },
  { category: 'CAT-ICED-COFFEE', name: 'Iced vanilla latte', numbers: { central: '59.5', chalong: '56.5' }, baht: 170 },
  { category: 'CAT-ICED-COFFEE', name: 'Iced caramel macchiato', numbers: { central: '59.6', chalong: '56.6' }, baht: 170 },
  // --- Chocolate -------------------------------------------------------------
  { category: 'CAT-CHOCOLATE', name: 'Hot chocolate', numbers: { central: '60.1', chalong: '57.1' }, baht: 130 },
  { category: 'CAT-CHOCOLATE', name: 'Iced chocolate', numbers: { central: '60.2', chalong: '57.2' }, baht: 150 },
  // --- Soda ------------------------------------------------------------------
  { category: 'CAT-SODA', name: 'Honey lemon', numbers: { central: '61.1', chalong: '58.1' }, baht: 135 },
  { category: 'CAT-SODA', name: 'Ginger lime', numbers: { central: '61.2', chalong: '58.2' }, baht: 135 },
  // --- Smoothies -------------------------------------------------------------
  { category: 'CAT-SMOOTHIES', name: 'Banana', numbers: { central: '62.1', chalong: '59.1' }, baht: 225 },
  { category: 'CAT-SMOOTHIES', name: 'Mixed berry', numbers: { central: '62.2', chalong: '59.2' }, baht: 225 },
  { category: 'CAT-SMOOTHIES', name: 'Mango & passion fruit', numbers: { central: '62.3', chalong: '59.3' }, baht: 225 },
  // --- Juice -----------------------------------------------------------------
  { category: 'CAT-JUICE', name: 'Fresh cold pressed orange juice', numbers: { central: '63.1', chalong: '60.1' }, baht: 210, servingNote: '300ml' },
  { category: 'CAT-JUICE', name: 'Fresh watermelon juice', numbers: { central: '63.2', chalong: '60.2' }, baht: 210, servingNote: '300ml' },
  // --- Tea pot ---------------------------------------------------------------
  { category: 'CAT-TEA-POT', name: 'English breakfast', numbers: { central: '64.1', chalong: '61.1' }, baht: 115 },
  { category: 'CAT-TEA-POT', name: 'Earl grey', numbers: { central: '64.2', chalong: '61.2' }, baht: 115 },
  { category: 'CAT-TEA-POT', name: 'Peppermint', numbers: { central: '64.3', chalong: '61.3' }, baht: 115 },
  { category: 'CAT-TEA-POT', name: 'Green tea', numbers: { central: '64.4', chalong: '61.4' }, baht: 115 },
  { category: 'CAT-TEA-POT', name: 'Camomile', numbers: { central: '64.5', chalong: '61.5' }, baht: 115 },
  // --- Soft drinks -----------------------------------------------------------
  { category: 'CAT-SOFT-DRINKS', name: 'Coke', numbers: { central: '65.1', chalong: '62.1' }, baht: 95 },
  { category: 'CAT-SOFT-DRINKS', name: 'Coke zero', numbers: { central: '65.2', chalong: '62.2' }, baht: 95 },
  { category: 'CAT-SOFT-DRINKS', name: 'S.Pellegrino Lemonata', numbers: { central: '65.3', chalong: '62.3' }, baht: 115 },
  { category: 'CAT-SOFT-DRINKS', name: 'S.Pellegrino sparkling water', numbers: { central: '65.4', chalong: '62.4' }, baht: 155 },
  { category: 'CAT-SOFT-DRINKS', name: 'Acqua Panna mineral water', numbers: { central: '65.5', chalong: '62.5' }, baht: 155 },
  { category: 'CAT-SOFT-DRINKS', name: 'Mineral water', numbers: { central: '65.6', chalong: '62.6' }, baht: 60 },
  { category: 'CAT-SOFT-DRINKS', name: 'Cranberry mors', numbers: { central: '65.7', chalong: '62.7' }, baht: 95 },
  // --- Kids juice ------------------------------------------------------------
  { category: 'CAT-KIDS-JUICE', name: 'Apple', numbers: { central: '66.1', chalong: '63.1' }, baht: 50 },
  { category: 'CAT-KIDS-JUICE', name: 'Orange', numbers: { central: '66.2', chalong: '63.2' }, baht: 50 },
  { category: 'CAT-KIDS-JUICE', name: 'Pineapple', numbers: { central: '66.3', chalong: '63.3' }, baht: 50 },
  { category: 'CAT-KIDS-JUICE', name: 'Cranberry mors', numbers: { central: '66.4', chalong: '63.4' }, baht: 50 },
  // --- Wine ------------------------------------------------------------------
  { category: 'CAT-WINE', name: 'Zardetto Prosecco DOC Burt, Italy', numbers: { central: '67', chalong: '64' }, baht: null, glassBaht: 350, bottleBaht: 1350, subsection: 'Bubbles' },
  { category: 'CAT-WINE', name: 'La Vie En Rose, France', numbers: { central: '68', chalong: '65' }, baht: null, glassBaht: 350, bottleBaht: 1550, subsection: 'Rose wine' },
  { category: 'CAT-WINE', name: 'Villa Maria, New Zealand', numbers: { central: '69', chalong: '66' }, baht: null, glassBaht: 350, bottleBaht: 1550, subsection: 'White wine' },
  // Bottle price only; no glass price printed.
  { category: 'CAT-WINE', name: 'Prope Montepulciano d’Abruzzo, Italy', numbers: { central: '70', chalong: '67' }, baht: null, bottleBaht: 1650, subsection: 'Red wine' },
  // --- Beer ------------------------------------------------------------------
  { category: 'CAT-BEER', name: 'Singha', numbers: { central: '71', chalong: '68' }, baht: 125 },
];

/**
 * Printed numbered lines per section and park, as counted on the two PDFs.
 * The data test holds MENU_LINES to these.
 */
export const PRINTED_LINE_COUNTS = {
  central: { 'CAT-BREAKFAST': 9, 'CAT-SIDES': 18, 'CAT-SHARING': 4, 'CAT-SOUP': 1, 'CAT-SALADS': 6, 'CAT-PASTA': 4, 'CAT-PIZZA': 9, 'CAT-MAINS': 8, 'CAT-ASIAN-FOOD': 7, 'CAT-KIDS': 8, 'CAT-DESSERTS': 2, 'CAT-COFFEE': 7, 'CAT-ICED-COFFEE': 6, 'CAT-CHOCOLATE': 2, 'CAT-SODA': 2, 'CAT-SMOOTHIES': 3, 'CAT-JUICE': 2, 'CAT-TEA-POT': 5, 'CAT-SOFT-DRINKS': 7, 'CAT-KIDS-JUICE': 4, 'CAT-WINE': 4, 'CAT-BEER': 1 },
  chalong: { 'CAT-BREAKFAST': 8, 'CAT-SIDES': 18, 'CAT-SHARING': 4, 'CAT-SOUP': 1, 'CAT-SALADS': 6, 'CAT-PASTA': 4, 'CAT-PIZZA': 9, 'CAT-MAINS': 7, 'CAT-ASIAN-FOOD': 7, 'CAT-KIDS': 7, 'CAT-DESSERTS': 2, 'CAT-COFFEE': 7, 'CAT-ICED-COFFEE': 6, 'CAT-CHOCOLATE': 2, 'CAT-SODA': 2, 'CAT-SMOOTHIES': 3, 'CAT-JUICE': 2, 'CAT-TEA-POT': 5, 'CAT-SOFT-DRINKS': 7, 'CAT-KIDS-JUICE': 4, 'CAT-WINE': 4, 'CAT-BEER': 1 },
} as const;
