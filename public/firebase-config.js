// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDnU33imrP1xCdZy51gkje94TGH7xQY53c",
  authDomain: "zentrack-a8f28.firebaseapp.com",
  projectId: "zentrack-a8f28",
  storageBucket: "zentrack-a8f28.firebasestorage.app",
  messagingSenderId: "1087608062123",
  appId: "1:1087608062123:web:8f001a634d2cf021d0f7ee",
  measurementId: "G-W8H6WWHWXF"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { auth, googleProvider, signInWithPopup };