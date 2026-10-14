from django.urls import path

from . import views

app_name = "galaxy"

urlpatterns = [
    path("", views.index, name="index"),
]
