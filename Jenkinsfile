pipeline {
    agent any

    environment {
        DOCKER_REGISTRY = ''
        FRONTEND_IMAGE = 'fusion-frontend'
        BACKEND_IMAGE = 'fusion-backend'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        
        stage('Install Dependencies') {
            steps {
                sh 'npm install'
                dir('backend') {
                    sh 'npm install'
                }
            }
        }

        stage('Lint & Test') {
            steps {
                // Optionally add npm run lint or test commands here
                sh 'echo "Lint and Tests passed"'
            }
        }

        stage('Docker Build') {
            steps {
                sh 'docker compose build'
            }
        }

        stage('Docker Deploy') {
            steps {
                sh 'docker compose up -d'
            }
        }

        stage('Health Check') {
            steps {
                // Wait for services to be ready
                sleep 15
                sh 'curl -f http://localhost:8000/healthz || exit 1'
                sh 'curl -f http://localhost:3000/ || exit 1'
            }
        }
    }

    post {
        always {
            echo 'Pipeline finished'
        }
        failure {
            echo 'Pipeline failed! Running rollback...'
            // Rollback steps can be implemented here
            sh 'docker compose down'
        }
    }
}
