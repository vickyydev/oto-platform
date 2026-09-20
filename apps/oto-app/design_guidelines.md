# Enterprise HR Scheduling - Design Guidelines

## Design Approach

**Selected System**: Material Design 3 + Custom Scheduling Components  
**Rationale**: Enterprise scheduling tool requiring dense information display, clear status communication, and complex grid layouts. Material Design provides robust foundation while custom components handle specialized scheduling visualization.

**Key Influences**: Planday's scheduling grid, Google Calendar's timeline controls, Linear's clean data presentation

---

## Core Design Principles

1. **Visual Status Priority**: Color-coded shifts enable instant schedule comprehension
2. **Grid Efficiency**: Maximize visible schedule data while maintaining readability
3. **Mobile-First Scheduling**: Compact 3-day view optimized for on-the-go access
4. **Financial Transparency**: Real-time budget tracking with clear variance indicators

---

## Color Palette

**Shift Status Colors**:
- Approved: #4CAF50 (green)
- Pending: #E57373 (coral/pink)
- Leave/Time Off: #FFD54F (yellow)
- Open Shifts Background: #E8EAF6 (light purple/blue)

**Interface Colors**:
- Header Bar: #212121 (dark gray, white text)
- Grid Background: #FAFAFA
- Row Alternating: White / #F5F5F5
- Budget Indicators: Green (#4CAF50) / Red (#EF5350)

**Neutral Scale**: Gray-50 to Gray-900 for borders, text hierarchy, disabled states

---

## Typography System

**Primary Font**: Roboto (Google Fonts)  
**Monospace**: Roboto Mono (for time ranges, hours, currency)

**Scale**:
- Page Title: text-2xl font-medium (24px)
- Section Headers: text-lg font-medium (18px)
- Shift Names: text-sm font-semibold (14px)
- Time Ranges: text-xs font-mono (12px)
- Employee Names: text-base font-medium (16px)
- Hours Summary: text-sm font-mono text-gray-600 (14px)
- Footer Stats: text-2xl font-bold (24px)

---

## Layout System

**Spacing Units**: Tailwind 1, 2, 3, 4, 6, 8 (4px, 8px, 12px, 16px, 24px, 32px)

**Grid Structure**:
- Sticky Left Column: Fixed w-64, contains employee info (avatar, name, hours summary)
- Scrollable Date Columns: min-w-32 per day, expands for multi-shift days
- Header Row: Sticky top with date labels and day-of-week
- Row Height: min-h-20 per employee row
- Grid Gaps: gap-1 between date columns, gap-2 between employee rows

**Container**: Full viewport width (no max-w), horizontal scroll enabled for wide schedules

---

## Component Library

### Navigation & Controls

**Header Bar**: Dark background (#212121) with px-6 py-4, contains:
- Logo/app name (left)
- Timeline toggle (center)
- Navigation controls: arrow buttons + "Today" button (center-right)
- User menu (right)

**Timeline Toggle**: Pill-style segmented control with 4 options (Day/3-Day/Week/Month), active state with solid background, inactive with transparent background and light border

**Navigation Arrows**: Icon buttons with rounded-md, hover state with lighter background, disabled state at schedule boundaries

**"Today" Button**: Text button with border, positioned between arrows

### Schedule Grid

**Employee Row Structure**:
- Avatar: w-10 h-10 rounded-full with initials or photo
- Name: font-medium, truncate if needed
- Hours Summary: Below name in smaller text with format "33h 30m / £335.00 / 5 Shifts"
- Row Background: Alternating stripe pattern

**Shift Cards**:
- Background: Status color (green/coral/yellow)
- Text: White, semibold
- Padding: px-3 py-2
- Border Radius: rounded-lg
- Content: Shift name (line 1), time range in mono font (line 2), "APPROVED" badge if applicable
- Badge: Uppercase text-xs with semi-transparent white background, rounded-full px-2 py-0.5
- Height: Minimum h-16, expands if multi-line shift names
- Multiple Shifts: Stack vertically with gap-1 within date cell

**Open Shifts Section**:
- Positioned at top of grid (above employee rows)
- Background: #E8EAF6 with distinct border-b-2
- Height: Same as employee rows (min-h-20)
- Label: "Open Shifts" in left column with people-outline icon
- Shift cards: Same styling but shows "Add Employee" action on hover

**Empty State**: Dashed border cell with "+ Add Shift" text centered, hover shows solid border

### Footer Statistics

**Stats Bar**: Fixed bottom position, white background with shadow-lg, px-6 py-4

**Stat Groups**: Three-column layout (Hours / Payroll / Revenue):
- Large number (text-2xl font-bold)
- Label below (text-sm text-gray-600)
- Percentage badge beside number: rounded-full px-2 py-1 text-xs font-semibold
  - Green background: Under/on budget
  - Red background: Over budget
  - Format: "+5%" or "-3%"

### Mobile Adaptations (< 768px)

**3-Day Compact View**:
- Smaller shift cards: px-2 py-1.5, text-xs
- Condensed employee info: Avatar only in left column (w-12), name hidden (shown in expandable detail)
- Reduced column width: min-w-24 per day
- Footer stats: Single row, horizontal scroll
- Timeline toggle: Icons only (no text labels)
- Shift details: Tap to expand overlay with full information

### Modals & Overlays

**Shift Creation Dialog**: Modal with two-column form (employee selection, shift details), date/time pickers with Material Design style, save actions with validation

**Employee Detail Sheet**: Slide-in panel from right showing full employee info, complete shift history, edit capabilities

**Bulk Actions Toolbar**: Appears above grid when rows selected, actions include Copy, Move, Delete with confirmation dialogs

---

## Animations

**Essential Only**:
- Shift card drag: Subtle lift shadow (duration-200)
- Modal entry: Fade + slide-up (duration-300)
- Status changes: Color transition (duration-150)
- Row expansion: Height animation (duration-200)

---

## Icons

**Library**: Material Icons (CDN)  
**Size**: 20px inline, 24px buttons, 16px within shift cards

**Key Icons**: today, chevron_left, chevron_right, people_outline, add, edit, delete, download, filter_list, calendar_view_day, calendar_view_week

---

## Accessibility

- Shift status communicated through text labels + color
- Grid keyboard navigation with arrow keys
- Screen reader announces row/column positions
- Focus indicators with ring-2 offset-1
- Sufficient color contrast on all shift backgrounds (WCAG AA)
- Time ranges always include AM/PM for clarity

---

## Images

**No images required** - This is a data-dense enterprise scheduling tool focused on calendar grids and functional displays. Employee avatars use initials or uploaded photos (circular crop).