export default function CampRulesPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="bg-teal-600 text-white px-4 py-5 sticky top-0 z-10">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold leading-tight">Camp Rules & Policies</h1>
          <p className="text-xs text-teal-100 mt-0.5">Please read carefully before registering</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-8 text-gray-700">

        {/* Intro */}
        <p className="text-sm leading-relaxed text-gray-600">
          To ensure a safe, fun, and positive experience for every child, we ask all campers and
          their families to follow the guidelines below. By registering, you agree to these terms
          on behalf of your child.
        </p>

        {/* Section 1 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
            Arrival & Departure
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children must be signed in by a parent or guardian each morning.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children will only be released to the parent/guardian or persons listed as authorized pick-up on the registration form. Valid ID may be required.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Please notify staff in advance if someone other than the registered pick-up person will collect your child.</li>
          </ul>
        </section>

        {/* Section 2 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
            Health & Safety
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children must be in good health to attend. Please keep your child at home if they are unwell (fever, vomiting, contagious illness, etc.).</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>All allergies, food restrictions, and medical conditions must be disclosed on the registration form.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Staff are not permitted to administer medication. Please inform us if your child requires medication during camp hours.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>In case of an emergency, we will contact you immediately using the emergency number provided. Please ensure it is reachable at all times.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children should wear comfortable clothing and closed-toe shoes suitable for active play.</li>
          </ul>
        </section>

        {/* Section 3 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
            Behaviour & Respect
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>All campers are expected to treat other children and staff with kindness and respect.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Bullying, aggressive behaviour, or intentional damage to property will not be tolerated.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children are encouraged to communicate with staff if they feel unsafe or uncomfortable.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Camp staff have the right to contact parents if a child's behaviour repeatedly disrupts the group.</li>
          </ul>
        </section>

        {/* Section 4 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>
            Personal Belongings
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Label all belongings clearly with your child's name.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Please do not bring valuables, electronics, or toys to camp.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>We are not responsible for lost or damaged personal items.</li>
          </ul>
        </section>

        {/* Section 5 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">5</span>
            Food & Snacks
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Snacks and meals will be provided. Please inform us of any dietary requirements or allergies during registration.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Children should bring a refillable water bottle clearly labelled with their name.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Please do not send outside food or snacks unless medically necessary.</li>
          </ul>
        </section>

        {/* Section 6 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">6</span>
            Photography & Privacy
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Photos and videos may be taken during camp activities for internal records and social media. Please let us know if you do not wish your child to be photographed.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Personal information collected during registration is kept confidential and used solely for camp administration.</li>
          </ul>
        </section>

        {/* Section 7 */}
        <section>
          <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 text-xs font-bold flex items-center justify-center flex-shrink-0">7</span>
            Cancellation & Refunds
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed">
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Please contact us as early as possible if your child cannot attend.</li>
            <li className="flex gap-2"><span className="text-teal-500 mt-1 flex-shrink-0">•</span>Refund and cancellation policies will be communicated at the time of booking confirmation.</li>
          </ul>
        </section>

        {/* Footer */}
        <div className="bg-teal-50 rounded-2xl p-4 text-sm text-teal-800 text-center">
          Thank you for taking the time to read our Camp Rules & Policies. We look forward to an amazing camp experience with your child! 🏕️
        </div>

        <div className="pb-8">
          <button
            onClick={() => {
              if (window.opener || window.history.length <= 1) {
                window.close();
              } else {
                window.history.back();
              }
            }}
            className="w-full py-3 rounded-xl bg-teal-600 text-white font-medium text-sm hover:bg-teal-700 transition-colors"
          >
            Got it — back to registration
          </button>
        </div>

      </div>
    </div>
  );
}
