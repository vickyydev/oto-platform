export interface CountryOption {
  name: string;
  dialCode: string;
  flag: string;
  iso2: string;
}

// Thailand is listed first and is the default. The rest are sorted alphabetically.
// Full global country/territory list with ITU dial codes.
export const COUNTRIES: CountryOption[] = [
  // Thailand — default
  { name: 'Thailand', dialCode: '66', flag: '🇹🇭', iso2: 'TH' },
  // A
  { name: 'Afghanistan', dialCode: '93', flag: '🇦🇫', iso2: 'AF' },
  { name: 'Albania', dialCode: '355', flag: '🇦🇱', iso2: 'AL' },
  { name: 'Algeria', dialCode: '213', flag: '🇩🇿', iso2: 'DZ' },
  { name: 'Andorra', dialCode: '376', flag: '🇦🇩', iso2: 'AD' },
  { name: 'Angola', dialCode: '244', flag: '🇦🇴', iso2: 'AO' },
  { name: 'Argentina', dialCode: '54', flag: '🇦🇷', iso2: 'AR' },
  { name: 'Armenia', dialCode: '374', flag: '🇦🇲', iso2: 'AM' },
  { name: 'Australia', dialCode: '61', flag: '🇦🇺', iso2: 'AU' },
  { name: 'Austria', dialCode: '43', flag: '🇦🇹', iso2: 'AT' },
  { name: 'Azerbaijan', dialCode: '994', flag: '🇦🇿', iso2: 'AZ' },
  // B
  { name: 'Bahrain', dialCode: '973', flag: '🇧🇭', iso2: 'BH' },
  { name: 'Bangladesh', dialCode: '880', flag: '🇧🇩', iso2: 'BD' },
  { name: 'Belarus', dialCode: '375', flag: '🇧🇾', iso2: 'BY' },
  { name: 'Belgium', dialCode: '32', flag: '🇧🇪', iso2: 'BE' },
  { name: 'Belize', dialCode: '501', flag: '🇧🇿', iso2: 'BZ' },
  { name: 'Benin', dialCode: '229', flag: '🇧🇯', iso2: 'BJ' },
  { name: 'Bhutan', dialCode: '975', flag: '🇧🇹', iso2: 'BT' },
  { name: 'Bolivia', dialCode: '591', flag: '🇧🇴', iso2: 'BO' },
  { name: 'Bosnia and Herzegovina', dialCode: '387', flag: '🇧🇦', iso2: 'BA' },
  { name: 'Botswana', dialCode: '267', flag: '🇧🇼', iso2: 'BW' },
  { name: 'Brazil', dialCode: '55', flag: '🇧🇷', iso2: 'BR' },
  { name: 'Brunei', dialCode: '673', flag: '🇧🇳', iso2: 'BN' },
  { name: 'Bulgaria', dialCode: '359', flag: '🇧🇬', iso2: 'BG' },
  { name: 'Burkina Faso', dialCode: '226', flag: '🇧🇫', iso2: 'BF' },
  { name: 'Burundi', dialCode: '257', flag: '🇧🇮', iso2: 'BI' },
  // C
  { name: 'Cambodia', dialCode: '855', flag: '🇰🇭', iso2: 'KH' },
  { name: 'Cameroon', dialCode: '237', flag: '🇨🇲', iso2: 'CM' },
  { name: 'Canada', dialCode: '1', flag: '🇨🇦', iso2: 'CA' },
  { name: 'Cape Verde', dialCode: '238', flag: '🇨🇻', iso2: 'CV' },
  { name: 'Central African Republic', dialCode: '236', flag: '🇨🇫', iso2: 'CF' },
  { name: 'Chad', dialCode: '235', flag: '🇹🇩', iso2: 'TD' },
  { name: 'Chile', dialCode: '56', flag: '🇨🇱', iso2: 'CL' },
  { name: 'China', dialCode: '86', flag: '🇨🇳', iso2: 'CN' },
  { name: 'Colombia', dialCode: '57', flag: '🇨🇴', iso2: 'CO' },
  { name: 'Comoros', dialCode: '269', flag: '🇰🇲', iso2: 'KM' },
  { name: 'Congo (DRC)', dialCode: '243', flag: '🇨🇩', iso2: 'CD' },
  { name: 'Congo (Republic)', dialCode: '242', flag: '🇨🇬', iso2: 'CG' },
  { name: 'Costa Rica', dialCode: '506', flag: '🇨🇷', iso2: 'CR' },
  { name: 'Croatia', dialCode: '385', flag: '🇭🇷', iso2: 'HR' },
  { name: 'Cuba', dialCode: '53', flag: '🇨🇺', iso2: 'CU' },
  { name: 'Cyprus', dialCode: '357', flag: '🇨🇾', iso2: 'CY' },
  { name: 'Czech Republic', dialCode: '420', flag: '🇨🇿', iso2: 'CZ' },
  // D
  { name: 'Denmark', dialCode: '45', flag: '🇩🇰', iso2: 'DK' },
  { name: 'Djibouti', dialCode: '253', flag: '🇩🇯', iso2: 'DJ' },
  { name: 'Dominican Republic', dialCode: '1849', flag: '🇩🇴', iso2: 'DO' },
  // E
  { name: 'Ecuador', dialCode: '593', flag: '🇪🇨', iso2: 'EC' },
  { name: 'Egypt', dialCode: '20', flag: '🇪🇬', iso2: 'EG' },
  { name: 'El Salvador', dialCode: '503', flag: '🇸🇻', iso2: 'SV' },
  { name: 'Eritrea', dialCode: '291', flag: '🇪🇷', iso2: 'ER' },
  { name: 'Estonia', dialCode: '372', flag: '🇪🇪', iso2: 'EE' },
  { name: 'Eswatini', dialCode: '268', flag: '🇸🇿', iso2: 'SZ' },
  { name: 'Ethiopia', dialCode: '251', flag: '🇪🇹', iso2: 'ET' },
  // F
  { name: 'Fiji', dialCode: '679', flag: '🇫🇯', iso2: 'FJ' },
  { name: 'Finland', dialCode: '358', flag: '🇫🇮', iso2: 'FI' },
  { name: 'France', dialCode: '33', flag: '🇫🇷', iso2: 'FR' },
  // G
  { name: 'Gabon', dialCode: '241', flag: '🇬🇦', iso2: 'GA' },
  { name: 'Gambia', dialCode: '220', flag: '🇬🇲', iso2: 'GM' },
  { name: 'Georgia', dialCode: '995', flag: '🇬🇪', iso2: 'GE' },
  { name: 'Germany', dialCode: '49', flag: '🇩🇪', iso2: 'DE' },
  { name: 'Ghana', dialCode: '233', flag: '🇬🇭', iso2: 'GH' },
  { name: 'Greece', dialCode: '30', flag: '🇬🇷', iso2: 'GR' },
  { name: 'Guatemala', dialCode: '502', flag: '🇬🇹', iso2: 'GT' },
  { name: 'Guinea', dialCode: '224', flag: '🇬🇳', iso2: 'GN' },
  { name: 'Guinea-Bissau', dialCode: '245', flag: '🇬🇼', iso2: 'GW' },
  { name: 'Guyana', dialCode: '592', flag: '🇬🇾', iso2: 'GY' },
  // H
  { name: 'Haiti', dialCode: '509', flag: '🇭🇹', iso2: 'HT' },
  { name: 'Honduras', dialCode: '504', flag: '🇭🇳', iso2: 'HN' },
  { name: 'Hong Kong', dialCode: '852', flag: '🇭🇰', iso2: 'HK' },
  { name: 'Hungary', dialCode: '36', flag: '🇭🇺', iso2: 'HU' },
  // I
  { name: 'Iceland', dialCode: '354', flag: '🇮🇸', iso2: 'IS' },
  { name: 'India', dialCode: '91', flag: '🇮🇳', iso2: 'IN' },
  { name: 'Indonesia', dialCode: '62', flag: '🇮🇩', iso2: 'ID' },
  { name: 'Iran', dialCode: '98', flag: '🇮🇷', iso2: 'IR' },
  { name: 'Iraq', dialCode: '964', flag: '🇮🇶', iso2: 'IQ' },
  { name: 'Ireland', dialCode: '353', flag: '🇮🇪', iso2: 'IE' },
  { name: 'Israel', dialCode: '972', flag: '🇮🇱', iso2: 'IL' },
  { name: 'Italy', dialCode: '39', flag: '🇮🇹', iso2: 'IT' },
  { name: 'Ivory Coast', dialCode: '225', flag: '🇨🇮', iso2: 'CI' },
  // J
  { name: 'Jamaica', dialCode: '1876', flag: '🇯🇲', iso2: 'JM' },
  { name: 'Japan', dialCode: '81', flag: '🇯🇵', iso2: 'JP' },
  { name: 'Jordan', dialCode: '962', flag: '🇯🇴', iso2: 'JO' },
  // K
  { name: 'Kazakhstan', dialCode: '7', flag: '🇰🇿', iso2: 'KZ' },
  { name: 'Kenya', dialCode: '254', flag: '🇰🇪', iso2: 'KE' },
  { name: 'Kuwait', dialCode: '965', flag: '🇰🇼', iso2: 'KW' },
  { name: 'Kyrgyzstan', dialCode: '996', flag: '🇰🇬', iso2: 'KG' },
  // L
  { name: 'Laos', dialCode: '856', flag: '🇱🇦', iso2: 'LA' },
  { name: 'Latvia', dialCode: '371', flag: '🇱🇻', iso2: 'LV' },
  { name: 'Lebanon', dialCode: '961', flag: '🇱🇧', iso2: 'LB' },
  { name: 'Lesotho', dialCode: '266', flag: '🇱🇸', iso2: 'LS' },
  { name: 'Liberia', dialCode: '231', flag: '🇱🇷', iso2: 'LR' },
  { name: 'Libya', dialCode: '218', flag: '🇱🇾', iso2: 'LY' },
  { name: 'Liechtenstein', dialCode: '423', flag: '🇱🇮', iso2: 'LI' },
  { name: 'Lithuania', dialCode: '370', flag: '🇱🇹', iso2: 'LT' },
  { name: 'Luxembourg', dialCode: '352', flag: '🇱🇺', iso2: 'LU' },
  // M
  { name: 'Macau', dialCode: '853', flag: '🇲🇴', iso2: 'MO' },
  { name: 'Madagascar', dialCode: '261', flag: '🇲🇬', iso2: 'MG' },
  { name: 'Malawi', dialCode: '265', flag: '🇲🇼', iso2: 'MW' },
  { name: 'Malaysia', dialCode: '60', flag: '🇲🇾', iso2: 'MY' },
  { name: 'Maldives', dialCode: '960', flag: '🇲🇻', iso2: 'MV' },
  { name: 'Mali', dialCode: '223', flag: '🇲🇱', iso2: 'ML' },
  { name: 'Malta', dialCode: '356', flag: '🇲🇹', iso2: 'MT' },
  { name: 'Mauritania', dialCode: '222', flag: '🇲🇷', iso2: 'MR' },
  { name: 'Mauritius', dialCode: '230', flag: '🇲🇺', iso2: 'MU' },
  { name: 'Mexico', dialCode: '52', flag: '🇲🇽', iso2: 'MX' },
  { name: 'Moldova', dialCode: '373', flag: '🇲🇩', iso2: 'MD' },
  { name: 'Monaco', dialCode: '377', flag: '🇲🇨', iso2: 'MC' },
  { name: 'Mongolia', dialCode: '976', flag: '🇲🇳', iso2: 'MN' },
  { name: 'Montenegro', dialCode: '382', flag: '🇲🇪', iso2: 'ME' },
  { name: 'Morocco', dialCode: '212', flag: '🇲🇦', iso2: 'MA' },
  { name: 'Mozambique', dialCode: '258', flag: '🇲🇿', iso2: 'MZ' },
  { name: 'Myanmar', dialCode: '95', flag: '🇲🇲', iso2: 'MM' },
  // N
  { name: 'Namibia', dialCode: '264', flag: '🇳🇦', iso2: 'NA' },
  { name: 'Nepal', dialCode: '977', flag: '🇳🇵', iso2: 'NP' },
  { name: 'Netherlands', dialCode: '31', flag: '🇳🇱', iso2: 'NL' },
  { name: 'New Zealand', dialCode: '64', flag: '🇳🇿', iso2: 'NZ' },
  { name: 'Nicaragua', dialCode: '505', flag: '🇳🇮', iso2: 'NI' },
  { name: 'Niger', dialCode: '227', flag: '🇳🇪', iso2: 'NE' },
  { name: 'Nigeria', dialCode: '234', flag: '🇳🇬', iso2: 'NG' },
  { name: 'North Korea', dialCode: '850', flag: '🇰🇵', iso2: 'KP' },
  { name: 'North Macedonia', dialCode: '389', flag: '🇲🇰', iso2: 'MK' },
  { name: 'Norway', dialCode: '47', flag: '🇳🇴', iso2: 'NO' },
  // O
  { name: 'Oman', dialCode: '968', flag: '🇴🇲', iso2: 'OM' },
  // P
  { name: 'Pakistan', dialCode: '92', flag: '🇵🇰', iso2: 'PK' },
  { name: 'Palestine', dialCode: '970', flag: '🇵🇸', iso2: 'PS' },
  { name: 'Panama', dialCode: '507', flag: '🇵🇦', iso2: 'PA' },
  { name: 'Papua New Guinea', dialCode: '675', flag: '🇵🇬', iso2: 'PG' },
  { name: 'Paraguay', dialCode: '595', flag: '🇵🇾', iso2: 'PY' },
  { name: 'Peru', dialCode: '51', flag: '🇵🇪', iso2: 'PE' },
  { name: 'Philippines', dialCode: '63', flag: '🇵🇭', iso2: 'PH' },
  { name: 'Poland', dialCode: '48', flag: '🇵🇱', iso2: 'PL' },
  { name: 'Portugal', dialCode: '351', flag: '🇵🇹', iso2: 'PT' },
  { name: 'Puerto Rico', dialCode: '1787', flag: '🇵🇷', iso2: 'PR' },
  // Q
  { name: 'Qatar', dialCode: '974', flag: '🇶🇦', iso2: 'QA' },
  // R
  { name: 'Romania', dialCode: '40', flag: '🇷🇴', iso2: 'RO' },
  { name: 'Russia', dialCode: '7', flag: '🇷🇺', iso2: 'RU' },
  { name: 'Rwanda', dialCode: '250', flag: '🇷🇼', iso2: 'RW' },
  // S
  { name: 'Saudi Arabia', dialCode: '966', flag: '🇸🇦', iso2: 'SA' },
  { name: 'Senegal', dialCode: '221', flag: '🇸🇳', iso2: 'SN' },
  { name: 'Serbia', dialCode: '381', flag: '🇷🇸', iso2: 'RS' },
  { name: 'Sierra Leone', dialCode: '232', flag: '🇸🇱', iso2: 'SL' },
  { name: 'Singapore', dialCode: '65', flag: '🇸🇬', iso2: 'SG' },
  { name: 'Slovakia', dialCode: '421', flag: '🇸🇰', iso2: 'SK' },
  { name: 'Slovenia', dialCode: '386', flag: '🇸🇮', iso2: 'SI' },
  { name: 'Solomon Islands', dialCode: '677', flag: '🇸🇧', iso2: 'SB' },
  { name: 'Somalia', dialCode: '252', flag: '🇸🇴', iso2: 'SO' },
  { name: 'South Africa', dialCode: '27', flag: '🇿🇦', iso2: 'ZA' },
  { name: 'South Korea', dialCode: '82', flag: '🇰🇷', iso2: 'KR' },
  { name: 'South Sudan', dialCode: '211', flag: '🇸🇸', iso2: 'SS' },
  { name: 'Spain', dialCode: '34', flag: '🇪🇸', iso2: 'ES' },
  { name: 'Sri Lanka', dialCode: '94', flag: '🇱🇰', iso2: 'LK' },
  { name: 'Sudan', dialCode: '249', flag: '🇸🇩', iso2: 'SD' },
  { name: 'Suriname', dialCode: '597', flag: '🇸🇷', iso2: 'SR' },
  { name: 'Sweden', dialCode: '46', flag: '🇸🇪', iso2: 'SE' },
  { name: 'Switzerland', dialCode: '41', flag: '🇨🇭', iso2: 'CH' },
  { name: 'Syria', dialCode: '963', flag: '🇸🇾', iso2: 'SY' },
  // T
  { name: 'Taiwan', dialCode: '886', flag: '🇹🇼', iso2: 'TW' },
  { name: 'Tajikistan', dialCode: '992', flag: '🇹🇯', iso2: 'TJ' },
  { name: 'Tanzania', dialCode: '255', flag: '🇹🇿', iso2: 'TZ' },
  { name: 'Timor-Leste', dialCode: '670', flag: '🇹🇱', iso2: 'TL' },
  { name: 'Togo', dialCode: '228', flag: '🇹🇬', iso2: 'TG' },
  { name: 'Trinidad and Tobago', dialCode: '1868', flag: '🇹🇹', iso2: 'TT' },
  { name: 'Tunisia', dialCode: '216', flag: '🇹🇳', iso2: 'TN' },
  { name: 'Turkey', dialCode: '90', flag: '🇹🇷', iso2: 'TR' },
  { name: 'Turkmenistan', dialCode: '993', flag: '🇹🇲', iso2: 'TM' },
  // U
  { name: 'UAE', dialCode: '971', flag: '🇦🇪', iso2: 'AE' },
  { name: 'Uganda', dialCode: '256', flag: '🇺🇬', iso2: 'UG' },
  { name: 'Ukraine', dialCode: '380', flag: '🇺🇦', iso2: 'UA' },
  { name: 'United Kingdom', dialCode: '44', flag: '🇬🇧', iso2: 'GB' },
  { name: 'United States', dialCode: '1', flag: '🇺🇸', iso2: 'US' },
  { name: 'Uruguay', dialCode: '598', flag: '🇺🇾', iso2: 'UY' },
  { name: 'Uzbekistan', dialCode: '998', flag: '🇺🇿', iso2: 'UZ' },
  // V
  { name: 'Venezuela', dialCode: '58', flag: '🇻🇪', iso2: 'VE' },
  { name: 'Vietnam', dialCode: '84', flag: '🇻🇳', iso2: 'VN' },
  // Y
  { name: 'Yemen', dialCode: '967', flag: '🇾🇪', iso2: 'YE' },
  // Z
  { name: 'Zambia', dialCode: '260', flag: '🇿🇲', iso2: 'ZM' },
  { name: 'Zimbabwe', dialCode: '263', flag: '🇿🇼', iso2: 'ZW' },
];

export const DEFAULT_COUNTRY = COUNTRIES[0]; // Thailand

export function findCountryByDialCode(dialCode: string): CountryOption | undefined {
  return COUNTRIES.find((c) => c.dialCode === dialCode);
}

export function filterCountries(query: string): CountryOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return COUNTRIES;
  return COUNTRIES.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.dialCode.includes(q) ||
      (`+${c.dialCode}`).includes(q),
  );
}
