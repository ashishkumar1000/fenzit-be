-- Create country_codes lookup table
CREATE TABLE country_codes (
  dial_code   TEXT PRIMARY KEY,          -- e.g. '+91'
  country_name TEXT NOT NULL,            -- e.g. 'India'
  iso2        CHAR(2) NOT NULL UNIQUE    -- e.g. 'IN'
);

-- Seed common country codes
INSERT INTO country_codes (dial_code, country_name, iso2) VALUES
  ('+1',   'United States / Canada',      'US'),
  ('+7',   'Russia',                       'RU'),
  ('+20',  'Egypt',                        'EG'),
  ('+27',  'South Africa',                 'ZA'),
  ('+30',  'Greece',                       'GR'),
  ('+31',  'Netherlands',                  'NL'),
  ('+32',  'Belgium',                      'BE'),
  ('+33',  'France',                       'FR'),
  ('+34',  'Spain',                        'ES'),
  ('+36',  'Hungary',                      'HU'),
  ('+39',  'Italy',                        'IT'),
  ('+40',  'Romania',                      'RO'),
  ('+41',  'Switzerland',                  'CH'),
  ('+43',  'Austria',                      'AT'),
  ('+44',  'United Kingdom',               'GB'),
  ('+45',  'Denmark',                      'DK'),
  ('+46',  'Sweden',                       'SE'),
  ('+47',  'Norway',                       'NO'),
  ('+48',  'Poland',                       'PL'),
  ('+49',  'Germany',                      'DE'),
  ('+51',  'Peru',                         'PE'),
  ('+52',  'Mexico',                       'MX'),
  ('+54',  'Argentina',                    'AR'),
  ('+55',  'Brazil',                       'BR'),
  ('+56',  'Chile',                        'CL'),
  ('+57',  'Colombia',                     'CO'),
  ('+58',  'Venezuela',                    'VE'),
  ('+60',  'Malaysia',                     'MY'),
  ('+61',  'Australia',                    'AU'),
  ('+62',  'Indonesia',                    'ID'),
  ('+63',  'Philippines',                  'PH'),
  ('+64',  'New Zealand',                  'NZ'),
  ('+65',  'Singapore',                    'SG'),
  ('+66',  'Thailand',                     'TH'),
  ('+81',  'Japan',                        'JP'),
  ('+82',  'South Korea',                  'KR'),
  ('+84',  'Vietnam',                      'VN'),
  ('+86',  'China',                        'CN'),
  ('+90',  'Turkey',                       'TR'),
  ('+91',  'India',                        'IN'),
  ('+92',  'Pakistan',                     'PK'),
  ('+93',  'Afghanistan',                  'AF'),
  ('+94',  'Sri Lanka',                    'LK'),
  ('+95',  'Myanmar',                      'MM'),
  ('+98',  'Iran',                         'IR'),
  ('+212', 'Morocco',                      'MA'),
  ('+213', 'Algeria',                      'DZ'),
  ('+216', 'Tunisia',                      'TN'),
  ('+218', 'Libya',                        'LY'),
  ('+220', 'Gambia',                       'GM'),
  ('+221', 'Senegal',                      'SN'),
  ('+234', 'Nigeria',                      'NG'),
  ('+254', 'Kenya',                        'KE'),
  ('+256', 'Uganda',                       'UG'),
  ('+255', 'Tanzania',                     'TZ'),
  ('+260', 'Zambia',                       'ZM'),
  ('+263', 'Zimbabwe',                     'ZW'),
  ('+351', 'Portugal',                     'PT'),
  ('+352', 'Luxembourg',                   'LU'),
  ('+353', 'Ireland',                      'IE'),
  ('+358', 'Finland',                      'FI'),
  ('+370', 'Lithuania',                    'LT'),
  ('+371', 'Latvia',                       'LV'),
  ('+372', 'Estonia',                      'EE'),
  ('+380', 'Ukraine',                      'UA'),
  ('+381', 'Serbia',                       'RS'),
  ('+385', 'Croatia',                      'HR'),
  ('+386', 'Slovenia',                     'SI'),
  ('+420', 'Czech Republic',               'CZ'),
  ('+421', 'Slovakia',                     'SK'),
  ('+880', 'Bangladesh',                   'BD'),
  ('+886', 'Taiwan',                       'TW'),
  ('+960', 'Maldives',                     'MV'),
  ('+966', 'Saudi Arabia',                 'SA'),
  ('+971', 'United Arab Emirates',         'AE'),
  ('+972', 'Israel',                       'IL'),
  ('+973', 'Bahrain',                      'BH'),
  ('+974', 'Qatar',                        'QA'),
  ('+975', 'Bhutan',                       'BT'),
  ('+976', 'Mongolia',                     'MN'),
  ('+977', 'Nepal',                        'NP'),
  ('+992', 'Tajikistan',                   'TJ'),
  ('+993', 'Turkmenistan',                 'TM'),
  ('+994', 'Azerbaijan',                   'AZ'),
  ('+995', 'Georgia',                      'GE'),
  ('+996', 'Kyrgyzstan',                   'KG'),
  ('+998', 'Uzbekistan',                   'UZ');

-- Add new columns to users (nullable initially for data migration)
ALTER TABLE users
  ADD COLUMN country_code TEXT,
  ADD COLUMN phone_number TEXT;

-- Migrate existing E.164 phone data → (country_code, phone_number)
-- Uses longest-prefix match against country_codes.dial_code
UPDATE users u
SET
  country_code = cc.dial_code,
  phone_number = substring(u.phone FROM length(cc.dial_code) + 1)
FROM country_codes cc
WHERE u.phone LIKE cc.dial_code || '%'
  AND NOT EXISTS (
    SELECT 1 FROM country_codes cc2
    WHERE u.phone LIKE cc2.dial_code || '%'
      AND length(cc2.dial_code) > length(cc.dial_code)
  );

-- Enforce NOT NULL after data migration
ALTER TABLE users
  ALTER COLUMN country_code SET NOT NULL,
  ALTER COLUMN phone_number  SET NOT NULL;

-- Add FK to country_codes
ALTER TABLE users
  ADD CONSTRAINT users_country_code_fkey
    FOREIGN KEY (country_code) REFERENCES country_codes (dial_code);

-- Add uniqueness on the full number (replaces the old phone UNIQUE index)
ALTER TABLE users
  ADD CONSTRAINT users_country_code_phone_number_unique UNIQUE (country_code, phone_number);

-- Drop old phone column (unique constraint drops automatically with the column)
ALTER TABLE users DROP COLUMN phone;
