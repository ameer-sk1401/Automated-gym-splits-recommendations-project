# 🏋️‍♂️ FitFlow CI/CD – Automated Gym Split Recommendation System

📅 Automated, scheduled gym split recommendation engine built with Python, JavaScript, GitHub Actions, and cron-based workflows, deployed continuously to Netlify.
🧠 Designed to automate daily and weekly workout plan generation — blending full-stack development with DevOps best practices.

⸻

	📌 Table of Contents
		•	Overview
		•	Architecture
		•	Key Features
		•	Tech Stack
		•	Project Workflow
		•	CI/CD Pipeline
		•	Scheduling with Cron
		•	Setup Instructions
		•	Local Development
		•	Deployment
		•	Future Enhancements
		•	License

⸻

📝 Overview

	FitFlow CI/CD is an automated gym workout recommendation system that dynamically generates workout split plans for users. It combines:
		•	Python backend for algorithmic recommendations.
		•	JavaScript frontend for collecting user preferences and displaying personalized plans.
		•	GitHub Actions for automated CI/CD workflows.
		•	Cron jobs for daily and weekly scheduled runs.
		•	Netlify for automatic production deployments on every push.

This project demonstrates how DevOps automation can be applied even to personal productivity tools, showcasing skills in workflow orchestration, cloud deployment, and scheduled pipelines.

⸻

    🏗 Architecture
      
                     +--------------------------+
                     |      GitHub Repo         |
                     | (Python + JS + Workflows)|
                     +-----------+--------------+
                                 |
                                 | Push to main branch
                                 v
      +----------------------+   +---------------------+    +----------------------+
      |  GitHub Actions CI   |-->| Netlify Deployment  |--->|  Live Web App (UI)   |
      |  (Lint/Test/Build)   |   | (CD via deploy key) |    |  Hosted on Netlify   |
      +----------------------+   +---------------------+    +----------------------+
              ^
              | Scheduled (cron)
              |
      +---------------------------+
      |  GitHub Actions Schedulers|
      |  - Daily run (9 AM)       |
      |  - Weekly summary         |
      +---------------------------+
              |
              v
      +----------------------------+
      | Python Scripts             |
      | - send_daily.py            |
      | - weekly_summary.py        |
      +----------------------------+


⸻

	✨ Key Features
		•	🧠 Algorithmic workout plan generator (Python)
		•	🌐 Interactive frontend built with JavaScript
		•	⚡ CI/CD pipeline for testing & Netlify deployment on every push
		•	⏰ Automated daily & weekly scheduled workflows using cron
		•	🔐 Secrets management for SMTP and environment variables
		•	🧰 Modular architecture ready for future serverless & data engineering integrations

⸻

	🧰 Tech Stack
		•	Frontend: HTML, CSS, JavaScript
		•	Backend: Python 3.11+
		•	Automation: GitHub Actions, Cron Jobs
		•	Deployment: Netlify (Continuous Delivery)
		•	Version Control: Git & GitHub

⸻

	🔄 Project Workflow
		1.	User visits the Netlify-hosted frontend.
		2.	Enters personal preferences (days/week, goals, etc.).
		3.	Python backend generates an optimal gym split plan.
		4.	Plans are displayed interactively in the UI.
		5.	Scheduled workflows run daily & weekly to trigger:
		•	Daily recommendation emails / updates.
		•	Weekly summary digest for progress and routine check.

⸻

🧪 CI/CD Pipeline

The CI/CD pipeline is powered by GitHub Actions and Netlify:

	🧰 CI (Continuous Integration)
		•	Triggered on every push to main.
		•	Installs dependencies (Node & Python).
		•	Runs linting / basic checks.
		•	Builds static frontend and prepares Python environment.
	
	🚀 CD (Continuous Delivery)
		•	Uses Netlify CLI with NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID secrets.
		•	Automatically deploys to production Netlify site on push — no manual steps.
		•	Deploy logs are visible in GitHub Actions UI.

      on:
        push:
          branches: [main]
      
      jobs:
        deploy:
          runs-on: ubuntu-latest
          steps:
            - uses: actions/checkout@v3
            - uses: actions/setup-node@v4
              with:
                node-version: 20
            - run: npm install -g netlify-cli
            - run: netlify deploy --prod --dir=.
              env:
                NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
                NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}


⸻

⏰ Scheduling with Cron

Two GitHub Actions workflows handle scheduling:

	🗓 Daily Workflow
		•	Runs every day at 9:00 AM (US/Eastern).
		•	Executes scripts/send_daily.py to send out recommendations.
	
	on:
	  schedule:
	    - cron: '0 13 * * *'  # 9 AM US/Eastern
	
	📅 Weekly Workflow
		•	Runs every Sunday at 8:00 AM.
		•	Triggers scripts/weekly_summary.py to email weekly summaries.

Both workflows run independently of user commits — fully automated.

⸻

⚙️ Setup Instructions
	1.	Clone the repo
	
	git clone https://github.com/your-username/fitflow-cicd.git
	cd fitflow-cicd
	
	
	2.	Set up Python environment
	
	python3 -m venv venv
	source venv/bin/activate
	pip install -r requirements.txt
	
	
	3.	Configure SMTP & Secrets
	Add the following secrets in GitHub → Settings → Secrets → Actions:
		•	SMTP_SERVER
		•	SMTP_PORT
		•	SMTP_USER
		•	SMTP_PASS
	
	
	4.	Set up Netlify (optional, for CD)
		•	Create a Netlify site and get your NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID.
		•	Add them as repository secrets.

⸻

🧪 Local Development

You can run scripts locally to test the recommendation generation:

	# Run daily recommendation logic locally
	python scripts/send_daily.py
	
	# Run weekly summary locally
	python scripts/weekly_summary.py

Frontend can be opened locally in any browser via index.html.

⸻

🚀 Deployment

Deployment is fully automated.
Just push changes to the main branch, and GitHub Actions will:
	•	Run tests
	•	Deploy to Netlify
	•	Trigger workflows if scheduled

⸻

🧭 Future Enhancements
	•	☁️ Migrate recommendation logic to AWS Lambda for serverless execution.
	•	🪄 Add DynamoDB / S3 for user data persistence.
	•	📊 Build a dashboard for workout history analytics.
	•	🧠 Integrate ML-based personalization for better recommendations.

⸻

📝 License

This project is licensed under the MIT License.
Use freely for personal or educational purposes.

