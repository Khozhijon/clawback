/**
 * The Firebase project this app talks to. These values identify the project; they are not
 * secrets (every Firebase web app ships them). What protects the Gemini API is App Check.
 */
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
}

/** reCAPTCHA Enterprise site key registered with App Check for the live site. Empty: debug provider only. */
export const RECAPTCHA_ENTERPRISE_SITE_KEY = ''

/** The cloud model used when the user allows a request to leave the device. */
export const CLOUD_MODEL = 'gemini-3.5-flash-lite'

export const configured = firebaseConfig.apiKey !== '' && firebaseConfig.appId !== ''
