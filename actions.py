from typing import Any, Text, Dict, List
from rasa_sdk import Action, Tracker, FormValidationAction
from rasa_sdk.executor import CollectingDispatcher
from rasa_sdk.types import DomainDict
from rasa_sdk.events import SlotSet, AllSlotsReset, ActiveLoop, UserUtteranceReverted
from datetime import datetime, timedelta
import logging
import re

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Constants
BUSINESS_HOURS_START = 9
BUSINESS_HOURS_END = 17
LUNCH_HOUR_START = 12
LUNCH_HOUR_END = 13

class ActionBookAppointment(Action):
    def name(self) -> Text:
        return "action_book_appointment"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Get current booking step if any
        current_step = tracker.get_slot("booking_step")
        
        # Check if we're already in a booking flow
        if current_step == "date":
            # We received a date in the previous step, now we're expecting specialist again
            # This means we need to extract date from the message
            message = tracker.latest_message.get("text", "")
            dispatcher.utter_message(response="utter_ask_appointment_time")
            return [SlotSet("appointment_date", message), SlotSet("booking_step", "time")]
            
        elif current_step == "time":
            # We received time in the previous step
            message = tracker.latest_message.get("text", "")
            dispatcher.utter_message(response="utter_ask_specialist")
            return [SlotSet("appointment_time", message), SlotSet("booking_step", "specialist")]
            
        # Check if we have a specialist from entity extraction
        specialist = next(tracker.get_latest_entity_values("specialist"), None)
        
        # If not, check if it's in the message text
        if not specialist:
            message = tracker.latest_message.get("text", "").lower()
            specialists = ["cardiologist", "pediatrician", "dermatologist", 
                          "neurologist", "dentist", "gynecologist", 
                          "orthopedic", "ent"]
            
            for spec in specialists:
                if spec in message:
                    specialist = spec
                    break
        
        # If we have a specialist, move to date; otherwise ask for specialist
        if specialist:
            dispatcher.utter_message(response="utter_ask_appointment_date")
            return [SlotSet("specialist", specialist), SlotSet("booking_step", "date")]
        else:
            dispatcher.utter_message(response="utter_ask_specialist")
            return [SlotSet("booking_step", "specialist")]

class ActionSetDate(Action):
    def name(self) -> Text:
        return "action_set_date"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Get the date from the message
        message = tracker.latest_message.get("text", "")
        
        # Extract date entity if available
        date_entity = next(tracker.get_latest_entity_values("date"), None)
        if date_entity:
            appointment_date = date_entity
        else:
            appointment_date = message
        
        # Ask for time
        dispatcher.utter_message(response="utter_ask_appointment_time")
        
        return [SlotSet("appointment_date", appointment_date), SlotSet("booking_step", "time")]

class ActionSetTime(Action):
    def name(self) -> Text:
        return "action_set_time"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Get the time from the message
        message = tracker.latest_message.get("text", "")
        
        # Extract time entity if available
        time_entity = next(tracker.get_latest_entity_values("time"), None)
        if time_entity:
            appointment_time = time_entity
        else:
            appointment_time = message
        
        # Get the previously stored information
        specialist = tracker.get_slot("specialist")
        appointment_date = tracker.get_slot("appointment_date")
        
        # Confirm the appointment
        response = (f"✅ Appointment confirmed!\n\n"
                   f"👨‍⚕️ Specialist: {specialist}\n"
                   f"📅 Date: {appointment_date}\n"
                   f"🕒 Time: {appointment_time}\n\n"
                   f"Would you like me to send you a reminder 24 hours before? ⏰")
        
        dispatcher.utter_message(text=response)
        
        return [SlotSet("appointment_time", appointment_time), SlotSet("booking_step", "complete")]

class ActionCancelBooking(Action):
    def name(self) -> Text:
        return "action_cancel_booking"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        dispatcher.utter_message("Appointment booking cancelled. How else can I help you?")
        
        return [AllSlotsReset()]

class ActionResetAppointmentForm(Action):
    """Resets the appointment form and all slots"""

    def name(self) -> Text:
        return "action_reset_appointment_form"
    
    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Check if the intent was goodbye
        intent = tracker.latest_message.get("intent", {}).get("name")
        
        if intent == "goodbye":
            dispatcher.utter_message("Goodbye! Take care of your health. 👋")
        else:
            dispatcher.utter_message("Appointment booking process has been cancelled. How else can I help you?")
        
        return [AllSlotsReset(), ActiveLoop(None)]

class ActionHandleSymptoms(Action):
    def name(self) -> Text:
        return "action_handle_symptoms"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Extract symptom and body part entities
        symptom = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                      if e["entity"] == "symptom"), None)
        body_part = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                        if e["entity"] == "body_part"), None)
        
        # Check for emergency symptoms
        emergency_symptoms = ["chest pain", "difficulty breathing", "severe bleeding", 
                             "unconscious", "seizure", "stroke", "heart attack"]
        
        if symptom and any(urgent in symptom.lower() for urgent in emergency_symptoms):
            return [SlotSet("symptom", symptom), 
                    SlotSet("body_part", body_part)]
        
        # Default response for non-emergency symptoms
        response = f"I understand you're experiencing {symptom or 'symptoms'}"
        if body_part:
            response += f" in your {body_part}"
        
        response += ". How long have you had this symptom? It would also help if you could describe the severity."
        
        dispatcher.utter_message(text=response)
        
        # Provide guidance based on symptom
        if symptom:
            if "fever" in symptom.lower():
                dispatcher.utter_message(text="For fever, it's important to stay hydrated and rest. If your temperature is above 103°F (39.4°C) or lasts more than three days, you should consult a doctor.")
            elif "headache" in symptom.lower():
                dispatcher.utter_message(text="Headaches can be caused by various factors including stress, dehydration, or lack of sleep. If it's severe or persistent, please consult a healthcare provider.")
            elif "cough" in symptom.lower():
                dispatcher.utter_message(text="For a cough, staying hydrated and using honey (if not contraindicated) may help. If it persists for more than a week or is accompanied by fever, seek medical advice.")
            else:
                dispatcher.utter_message(text="Would you like to book an appointment with a healthcare provider to discuss your symptoms?")
        
        return [SlotSet("symptom", symptom), 
                SlotSet("body_part", body_part)]


class ActionProvideMedicationInfo(Action):
    def name(self) -> Text:
        return "action_provide_medication_info"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        medication = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                         if e["entity"] == "medication"), None)
        
        if not medication:
            dispatcher.utter_message(text="Which medication would you like information about?")
            return []
        
        # Dictionary of common medications with their information
        medication_info = {
            "paracetamol": {
                "use": "Pain relief and reducing fever",
                "side_effects": "Rarely causes side effects when taken as directed, but may include nausea and liver damage in high doses",
                "dosage": "Adults: 500-1000 mg every 4-6 hours as needed, not exceeding 4000 mg in 24 hours"
            },
            "ibuprofen": {
                "use": "Pain relief, reducing inflammation and fever",
                "side_effects": "Stomach pain, heartburn, dizziness, mild allergic reactions",
                "dosage": "Adults: 200-400 mg every 4-6 hours as needed, not exceeding 1200 mg in 24 hours unless directed by a doctor"
            },
            "aspirin": {
                "use": "Pain relief, reducing inflammation, fever, and prevention of blood clots",
                "side_effects": "Stomach irritation, increased risk of bleeding, allergic reactions",
                "dosage": "Adults: 300-600 mg every 4-6 hours for pain/fever, 75-100 mg daily for prevention of clots"
            },
            "amoxicillin": {
                "use": "Antibiotic used to treat bacterial infections",
                "side_effects": "Diarrhea, stomach upset, rash, allergic reactions",
                "dosage": "Varies by condition; typically 250-500 mg three times daily for adults"
            }
        }
        
        # Get information for requested medication or provide general response
        med_info = medication_info.get(medication.lower(), {
            "use": "treating specific medical conditions",
            "side_effects": "various effects depending on the individual",
            "dosage": "as prescribed by your healthcare provider"
        })
        
        response = f"📋 Information about {medication}:\n\n"
        response += f"Primary use: {med_info['use']}\n"
        response += f"Common side effects: {med_info['side_effects']}\n"
        response += f"Typical dosage: {med_info['dosage']}\n\n"
        response += "⚠️ Important: Always follow your healthcare provider's instructions and read the medication leaflet."
        
        dispatcher.utter_message(text=response)
        return [SlotSet("medication", medication)]


class ActionEmergencyTriage(Action):
    def name(self) -> Text:
        return "action_emergency_triage"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        message = tracker.latest_message.get("text", "").lower()
        
        # Critical emergency keywords requiring immediate attention
        critical_keywords = ["heart attack", "stroke", "not breathing", "unconscious", 
                            "severe bleeding", "seizure", "anaphylaxis", "allergic reaction"]
        
        if any(keyword in message for keyword in critical_keywords):
            response = "⚠️ 🚨 MEDICAL EMERGENCY - CALL 911 IMMEDIATELY 🚨 ⚠️\n\n"
            response += "This appears to be a life-threatening emergency requiring immediate medical attention. Please:\n"
            response += "1. Call emergency services (911) right now\n"
            response += "2. Do not attempt to transport the person yourself\n"
            response += "3. Stay on the line with emergency services and follow their instructions"
            
            dispatcher.utter_message(text=response)
        else:
            response = "⚠️ This sounds serious and requires urgent medical attention. Please:\n\n"
            response += "1. Call emergency services (911) or\n"
            response += "2. Go to the nearest emergency room immediately\n"
            response += "3. Do not delay seeking medical help\n\n"
            response += "Would you like me to help locate the nearest emergency room?"
            
            dispatcher.utter_message(text=response)
        
        return []


class ActionProvideConditionInfo(Action):
    def name(self) -> Text:
        return "action_provide_condition_info"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        condition = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                        if e["entity"] == "condition"), None)
        
        if not condition:
            dispatcher.utter_message(text="Which medical condition would you like information about?")
            return []
        
        # Dictionary of common conditions with their information
        condition_info = {
            "diabetes": {
                "description": "A chronic condition that affects how your body turns food into energy, characterized by high blood sugar levels",
                "symptoms": "Increased thirst and urination, fatigue, blurred vision, slow-healing sores",
                "management": "Blood sugar monitoring, medication or insulin, healthy diet, regular exercise, weight management"
            },
            "hypertension": {
                "description": "High blood pressure that can lead to serious health problems if left untreated",
                "symptoms": "Often asymptomatic, but may include headaches, shortness of breath, nosebleeds",
                "management": "Medication, low-sodium diet, regular exercise, limiting alcohol, stress management"
            },
            "asthma": {
                "description": "A condition affecting the airways, causing wheezing, breathlessness, chest tightness and coughing",
                "symptoms": "Wheezing, coughing, shortness of breath, chest tightness, often worse at night or early morning",
                "management": "Inhalers (preventers and relievers), avoiding triggers, breathing exercises, medication"
            },
            "covid-19": {
                "description": "An infectious disease caused by the SARS-CoV-2 virus that primarily affects the respiratory system",
                "symptoms": "Fever, cough, fatigue, loss of taste or smell, sore throat, headache, body aches",
                "management": "Rest, fluids, over-the-counter fever reducers, isolation to prevent spread, medical care if symptoms worsen"
            }
        }
        
        # Get information for requested condition or provide general response
        cond_info = condition_info.get(condition.lower(), {
            "description": "a recognized medical condition",
            "symptoms": "various symptoms that can differ from person to person",
            "management": "treatment options that should be discussed with a healthcare provider"
        })
        
        response = f"📋 Information about {condition}:\n\n"
        response += f"Description: {cond_info['description']}\n\n"
        response += f"Common symptoms: {cond_info['symptoms']}\n\n"
        response += f"Management: {cond_info['management']}\n\n"
        response += "⚠️ Important: This is general information only. Please consult with a healthcare provider for personal medical advice."
        
        dispatcher.utter_message(text=response)
        return [SlotSet("condition", condition)]


class ActionFindSpecialist(Action):
    def name(self) -> Text:
        return "action_find_specialist"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        specialist = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                         if e["entity"] == "specialist"), None)
        
        if not specialist:
            dispatcher.utter_message(text="What type of healthcare specialist are you looking for?")
            return []
        
        # Dictionary of specialists with their information
        specialist_info = {
            "cardiologist": {
                "description": "Specializes in diagnosing and treating heart conditions",
                "when_to_see": "Heart disease, chest pain, high blood pressure, heart rhythm issues",
                "preparation": "Bring medical history, list of medications, recent test results"
            },
            "neurologist": {
                "description": "Specializes in diagnosing and treating disorders of the nervous system",
                "when_to_see": "Headaches, seizures, stroke, memory problems, movement disorders",
                "preparation": "Document symptoms, bring medical history and test results"
            },
            "dermatologist": {
                "description": "Specializes in conditions affecting the skin, hair, and nails",
                "when_to_see": "Acne, eczema, psoriasis, skin cancer screening, unexplained rashes",
                "preparation": "Avoid wearing makeup, bring list of skin products you use"
            },
            "pediatrician": {
                "description": "Specializes in the care of children from birth to adolescence",
                "when_to_see": "Child wellness visits, vaccinations, developmental concerns, illnesses",
                "preparation": "Bring vaccination records, list of concerns or questions"
            }
        }
        
        # Get information for requested specialist or provide general response
        spec_info = specialist_info.get(specialist.lower(), {
            "description": "a healthcare provider with specialized training",
            "when_to_see": "specific medical conditions related to their specialty",
            "preparation": "your medical history, list of current medications, and questions"
        })
        
        response = f"📋 Information about {specialist} specialists:\n\n"
        response += f"A {specialist} {spec_info['description']}\n\n"
        response += f"When to see them: {spec_info['when_to_see']}\n\n"
        response += f"How to prepare for your visit: {spec_info['preparation']}\n\n"
        response += "Would you like to book an appointment with a specialist?"
        
        dispatcher.utter_message(text=response)
        return [SlotSet("specialist", specialist)]


class ActionProvideCOVIDInfo(Action):
    def name(self) -> Text:
        return "action_provide_covid_info"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        message = tracker.latest_message.get("text", "").lower()
        
        # Check for specific COVID-related queries
        if "test" in message or "testing" in message:
            response = "COVID-19 Testing Information:\n\n"
            response += "• PCR tests: Most accurate, results typically within 24-72 hours\n"
            response += "• Rapid antigen tests: Results in 15-30 minutes, less sensitive than PCR\n"
            response += "• Home tests: Available at pharmacies, follow instructions carefully\n\n"
            response += "Testing is recommended if you have symptoms, were exposed to someone with COVID-19, or before/after travel."
        
        elif "vaccine" in message or "vaccination" in message:
            response = "COVID-19 Vaccine Information:\n\n"
            response += "• Vaccines are safe, effective, and recommended for most people\n"
            response += "• Initial vaccination typically requires 1-2 doses depending on the vaccine\n"
            response += "• Boosters are recommended to maintain protection\n"
            response += "• Common side effects include soreness at injection site, fatigue, and mild fever\n\n"
            response += "Consult your healthcare provider about which vaccine is right for you."
        
        elif "symptom" in message:
            response = "COVID-19 Symptoms:\n\n"
            response += "• Fever or chills\n"
            response += "• Cough\n"
            response += "• Shortness of breath\n"
            response += "• Fatigue\n"
            response += "• Muscle or body aches\n"
            response += "• Headache\n"
            response += "• New loss of taste or smell\n"
            response += "• Sore throat\n"
            response += "• Congestion or runny nose\n"
            response += "• Nausea or vomiting\n"
            response += "• Diarrhea\n\n"
            response += "Symptoms may appear 2-14 days after exposure. If you have symptoms, get tested and isolate."
        
        elif "quarantine" in message or "isolate" in message:
            response = "COVID-19 Isolation Guidelines:\n\n"
            response += "If you test positive for COVID-19:\n"
            response += "• Stay home for at least 5 days\n"
            response += "• If you have no symptoms or symptoms are resolving after 5 days, you can leave isolation\n"
            response += "• Continue to wear a mask around others for 5 additional days\n\n"
            response += "If you were exposed to COVID-19:\n"
            response += "• If vaccinated: Monitor for symptoms and test 5-7 days after exposure\n"
            response += "• If unvaccinated: Quarantine for 5 days and get tested"
        
        else:
            response = "COVID-19 General Information:\n\n"
            response += "COVID-19 is caused by the SARS-CoV-2 virus and primarily spreads through respiratory droplets.\n\n"
            response += "Prevention:\n"
            response += "• Stay up to date with vaccines and boosters\n"
            response += "• Maintain good hand hygiene\n"
            response += "• Consider wearing masks in crowded indoor settings\n"
            response += "• Improve ventilation when possible\n"
            response += "• Stay home when sick\n\n"
            response += "What specific COVID-19 information are you looking for? (symptoms, testing, vaccines, isolation guidelines)"
        
        dispatcher.utter_message(text=response)
        return []


class ActionProvideMentalHealthResources(Action):
    def name(self) -> Text:
        return "action_provide_mental_health_resources"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        message = tracker.latest_message.get("text", "").lower()
        
        # Determine the type of mental health support needed
        if "depression" in message or "depressed" in message:
            condition = "depression"
            resources = [
                "National Alliance on Mental Illness (NAMI): 1-800-950-NAMI (6264)",
                "Depression and Bipolar Support Alliance: dbsalliance.org",
                "Mental Health America: mentalhealthamerica.net"
            ]
            self_help = [
                "Maintain a regular daily routine",
                "Exercise regularly, even light walking can help",
                "Set small, achievable goals",
                "Try to spend time with supportive people",
                "Consider mindfulness or meditation practices"
            ]
        
        elif "anxiety" in message or "anxious" in message or "panic" in message:
            condition = "anxiety"
            resources = [
                "Anxiety and Depression Association of America: adaa.org",
                "National Alliance on Mental Illness (NAMI): 1-800-950-NAMI (6264)",
                "Crisis Text Line: Text HOME to 741741"
            ]
            self_help = [
                "Practice deep breathing exercises",
                "Try progressive muscle relaxation",
                "Limit caffeine and alcohol",
                "Get regular physical activity",
                "Maintain a regular sleep schedule"
            ]
        
        elif "stress" in message or "overwhelmed" in message:
            condition = "stress"
            resources = [
                "American Institute of Stress: stress.org",
                "National Alliance on Mental Illness (NAMI): 1-800-950-NAMI (6264)",
                "MentalHealth.gov: mentalhealth.gov"
            ]
            self_help = [
                "Practice time management techniques",
                "Take short breaks throughout the day",
                "Engage in physical activity",
                "Try relaxation techniques like deep breathing",
                "Maintain social connections"
            ]
        
        else:
            condition = "mental health concerns"
            resources = [
                "National Alliance on Mental Illness (NAMI): 1-800-950-NAMI (6264)",
                "Substance Abuse and Mental Health Services Administration (SAMHSA): 1-800-662-HELP (4357)",
                "National Suicide Prevention Lifeline: 1-800-273-8255",
                "Crisis Text Line: Text HOME to 741741"
            ]
            self_help = [
                "Maintain a regular sleep schedule",
                "Eat balanced meals",
                "Exercise regularly",
                "Avoid alcohol and drugs",
                "Connect with supportive people"
            ]
        
        response = f"Mental Health Support for {condition}:\n\n"
        response += "🔸 It's important to know that you're not alone, and support is available.\n\n"
        response += "Resources that may help:\n"
        for resource in resources:
            response += f"• {resource}\n"
        
        response += "\nSelf-help strategies:\n"
        for strategy in self_help:
            response += f"• {strategy}\n"
        
        response += "\n⚠️ If you're experiencing thoughts of harming yourself or others, please call the National Suicide Prevention Lifeline at 1-800-273-8255 immediately or go to your nearest emergency room."
        response += "\n\nWould you like information about finding a mental health professional?"
        
        dispatcher.utter_message(text=response)
        return []


class ActionExplainMedicalProcedure(Action):
    def name(self) -> Text:
        return "action_explain_medical_procedure"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        procedure = next((e["value"] for e in tracker.latest_message.get("entities", []) 
                         if e["entity"] == "procedure"), None)
        
        if not procedure:
            dispatcher.utter_message(text="Which medical procedure would you like information about?")
            return []
        
        # Dictionary of procedures with their information
        procedure_info = {
            "mri": {
                "description": "Magnetic Resonance Imaging (MRI) uses magnetic fields and radio waves to create detailed images of organs and tissues",
                "preparation": "Remove metal objects, inform technician of implants or devices, may require fasting depending on body area",
                "procedure": "Lie still on a table that slides into a tube-shaped scanner. The machine makes loud knocking sounds during the scan.",
                "duration": "30-60 minutes typically",
                "aftercare": "No special care needed, resume normal activities"
            },
            "colonoscopy": {
                "description": "Examination of the large intestine (colon) using a flexible tube with a camera",
                "preparation": "Diet restrictions for 1-3 days, bowel cleansing preparation, arrange transportation home",
                "procedure": "Sedation given, then a colonoscope is inserted to examine the colon",
                "duration": "30-60 minutes typically",
                "aftercare": "Rest for remainder of day, may experience mild cramping or bloating"
            },
            "x-ray": {
                "description": "Uses small amounts of radiation to create images of bones and certain tissues",
                "preparation": "Remove jewelry and metal objects, may need to wear a gown",
                "procedure": "Position body as directed, hold still while the X-ray is taken",
                "duration": "5-15 minutes typically",
                "aftercare": "No special care needed, resume normal activities"
            },
            "biopsy": {
                "description": "Removal of a small sample of tissue for examination",
                "preparation": "May require fasting, stopping certain medications, or lab tests",
                "procedure": "Local anesthetic applied, small sample taken via needle or surgical procedure",
                "duration": "Varies from 15 minutes to longer for surgical biopsies",
                "aftercare": "Keep area clean and dry, watch for signs of infection, follow specific aftercare instructions"
            }
        }
        
        # Get information for requested procedure or provide general response
        proc_info = procedure_info.get(procedure.lower(), {
            "description": "a medical procedure used for diagnosis or treatment",
            "preparation": "specific instructions provided by your healthcare provider",
            "procedure": "steps that will be explained by your healthcare provider",
            "duration": "varies depending on the specific procedure",
            "aftercare": "instructions that will be provided by your healthcare provider"
        })
        
        response = f"📋 About {procedure.upper()}:\n\n"
        response += f"What it is: {proc_info['description']}\n\n"
        response += f"Preparation: {proc_info['preparation']}\n\n"
        response += f"During the procedure: {proc_info['procedure']}\n\n"
        response += f"Duration: {proc_info['duration']}\n\n"
        response += f"After the procedure: {proc_info['aftercare']}\n\n"
        response += "⚠️ Note: This is general information. Your healthcare provider will give you specific instructions for your procedure."
        
        dispatcher.utter_message(text=response)
        return [SlotSet("procedure", procedure)]


class ActionSubmitAppointmentForm(Action):
    """Submit the appointment form"""

    def name(self) -> Text:
        return "action_submit_appointment_form"
    
    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        # Get the slot values
        specialist = tracker.get_slot("specialist")
        appointment_date = tracker.get_slot("appointment_date")
        appointment_time = tracker.get_slot("appointment_time")
        
        # Confirm the appointment
        response = (f"✅ Appointment confirmed!\n\n"
                   f"👨‍⚕️ Specialist: {specialist}\n"
                   f"📅 Date: {appointment_date}\n"
                   f"🕒 Time: {appointment_time}\n\n"
                   f"Would you like me to send you a reminder 24 hours before? ⏰")
        
        dispatcher.utter_message(text=response)
        
        # Reset all slots and the active loop
        return [AllSlotsReset(), ActiveLoop(None)]


class ActionDefaultFallback(Action):
    def name(self) -> Text:
        return "action_default_fallback"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        
        dispatcher.utter_message(text="I'm sorry, I didn't quite understand that. As a medical assistant, I can help with:")
        dispatcher.utter_message(text="• Information about symptoms and medical conditions")
        dispatcher.utter_message(text="• Medication information")
        dispatcher.utter_message(text="• Booking appointments with specialists")
        dispatcher.utter_message(text="• Medical procedure information")
        dispatcher.utter_message(text="• Lifestyle and prevention advice")
        dispatcher.utter_message(text="• Mental health resources")
        dispatcher.utter_message(text="Could you please rephrase your question?")
        
        return [UserUtteranceReverted()]


class ValidateAppointmentForm(FormValidationAction):
    def name(self) -> Text:
        return "validate_appointment_form"

    def validate_specialist(
        self, slot_value: Any, dispatcher: CollectingDispatcher, tracker: Tracker, domain: Dict
    ) -> Dict[Text, Any]:
        """Validate specialist value."""
        
        # List of valid specialists
        valid_specialists = ["cardiologist", "pediatrician", "dermatologist", 
                            "neurologist", "dentist", "gynecologist", 
                            "orthopedic", "ent"]
        
        if slot_value.lower() in valid_specialists:
            return {"specialist": slot_value}
        else:
            # Don't output validation message for every slot
            # Only when specialist is the requested slot
            if tracker.get_slot("requested_slot") == "specialist":
                dispatcher.utter_message(text=f"I'm not familiar with '{slot_value}' specialist. Please choose from the available specialists.")
            return {"specialist": None}

    def validate_appointment_date(
        self, slot_value: Any, dispatcher: CollectingDispatcher, tracker: Tracker, domain: Dict
    ) -> Dict[Text, Any]:
        """Validate appointment_date value."""
        
        # List of valid date formats
        valid_dates = ["today", "tomorrow", "next monday", "next tuesday", 
                      "next wednesday", "next thursday", "next friday"]
        
        # Check for date format (YYYY-MM-DD)
        date_pattern = r'\d{4}-\d{2}-\d{2}'
        
        if slot_value.lower() in valid_dates or re.match(date_pattern, slot_value):
            return {"appointment_date": slot_value}
        else:
            # Only show validation message when this is the requested slot
            if tracker.get_slot("requested_slot") == "appointment_date":
                dispatcher.utter_message(text="I couldn't understand that date. Please use one of the suggested formats.")
            return {"appointment_date": None}

    def validate_appointment_time(
        self, slot_value: Any, dispatcher: CollectingDispatcher, tracker: Tracker, domain: Dict
    ) -> Dict[Text, Any]:
        """Validate appointment_time value."""
        
        # Some validation for time
        # You can add more patterns as needed
        time_pattern = r'(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?'
        
        if re.match(time_pattern, slot_value):
            return {"appointment_time": slot_value}
        else:
            # Only show validation message when this is the requested slot
            if tracker.get_slot("requested_slot") == "appointment_time":
                dispatcher.utter_message(text="I couldn't understand that time. Please provide a time like '9 AM', '2:30 PM', or '14:30'.")
            return {"appointment_time": None}
        
        
class ActionDeactivateLoop(Action):
    """Action to deactivate the loop"""

    def name(self) -> Text:
        return "action_deactivate_loop"

    def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: Dict[Text, Any],
    ) -> List[Dict[Text, Any]]:
        dispatcher.utter_message("Form deactivated. How else can I help you?")
        return [AllSlotsReset(), ActiveLoop(None)]