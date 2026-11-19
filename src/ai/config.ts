/**
 * The Firebase project this app talks to. These values identify the project; they are not
 * secrets (every Firebase web app ships them). What protects the Gemini API is App Check.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyB3iRGJe8YtjJOdFs2E90UrTp7Zaw9YWIk',
  authDomain: 'clawback-4f5ed.firebaseapp.com',
  projectId: 'clawback-4f5ed',
  storageBucket: 'clawback-4f5ed.firebasestorage.app',
  messagingSenderId: '913723773422',
  appId: '1:913723773422:web:82aeb6ecd2252043803eff',
}

/** reCAPTCHA Enterprise site key registered with App Check for khozhijon.github.io. Public by design; on localhost a debug token is used instead. */
export const RECAPTCHA_ENTERPRISE_SITE_KEY: string = '6LcarCcuAAAAAOfZeuMnrkzejP6w4F5y3zHI1mZn'

/** The cloud model used when the user allows a request to leave the device. */
export const CLOUD_MODEL = 'gemini-3.5-flash-lite'

export const configured = firebaseConfig.apiKey !== '' && firebaseConfig.appId !== ''
