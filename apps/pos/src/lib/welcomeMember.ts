import type { Member } from '@/types';

/**
 * SCRUM-885 — WHO THE CUSTOMER SIDE WELCOMES BACK.
 *
 * The prototype's welcome screen (`CustomerDisplay`, stage `welcome`) has two
 * greetings and no third: "Welcome back, {name}! Great to see you again." for
 * the member the membership check FOUND, and "Welcome to Oto — Thailand's
 * happiest indoor play park" for everyone else. In the prototype a number
 * nobody knows stays without a member on the sale, so a family seen for the
 * first time always got the second.
 *
 * The till's "New member?" box (SCRUM-31) puts the member it has just created
 * on the sale, and the welcome screen read that as a member it had found: a
 * family registered seconds earlier was told "Great to see you again". The
 * screen's rule is the prototype's, unchanged; what it is handed is fixed
 * here. A member created on this sale is not shown to the welcome screen, so
 * it greets them as the prototype greets any first visit, and both customer
 * screens — the till's own half and a separate display — are handed the same.
 *
 * Only the welcome stage: every later screen still has the member (their
 * name, and "Member rate applied" on the order once their rate is the sale's).
 */
export function welcomedMember(
  stage: string,
  member: Member | null,
  createdOnThisSale: string | null,
): Member | null {
  return stage === 'welcome' && member !== null && member.id === createdOnThisSale ? null : member;
}
